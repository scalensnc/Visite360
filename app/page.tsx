"use client";

import * as THREE from "three";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Neighbor = {
  id: number;
  yaw: number;
  pitch: number;
  distance: number;
};

type Panorama = {
  id: number;
  image: string;
  label: string;
  area: string;
  floor: number;
  position: {
    x: number;
    y: number;
    z: number;
    mapX: number;
    mapY: number;
  };
  neighbors: Neighbor[];
};

type Manifest = {
  site: {
    name: string;
    captured: string;
    panoramaCount: number;
    bounds: { width: number; height: number };
  };
  panoramas: Panorama[];
};

type MeasurePoint = { x: number; y: number };

const FLOOR_LABELS: Record<number, string> = {
  [-1]: "Sous-sol",
  0: "Rez",
  1: "Niveau 1",
  2: "Niveau 2",
};

function wrapAngle(angle: number) {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

function MapPlot({
  panoramas,
  currentId,
  floor,
  onSelect,
}: {
  panoramas: Panorama[];
  currentId: number;
  floor: number;
  onSelect: (id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visible = useMemo(
    () => panoramas.filter((panorama) => panorama.floor === floor),
    [floor, panoramas],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      context.strokeStyle = "rgba(109, 131, 153, .18)";
      context.lineWidth = 1;
      for (let x = 24; x < rect.width; x += 32) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, rect.height);
        context.stroke();
      }
      for (let y = 24; y < rect.height; y += 32) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(rect.width, y);
        context.stroke();
      }

      const pad = 30;
      const point = (panorama: Panorama) => ({
        x: pad + panorama.position.mapX * (rect.width - pad * 2),
        y: pad + panorama.position.mapY * (rect.height - pad * 2),
      });
      const visibleById = new Map(visible.map((item) => [item.id, item]));

      context.lineCap = "round";
      context.lineWidth = 3;
      context.strokeStyle = "rgba(52, 143, 240, .38)";
      visible.forEach((panorama) => {
        panorama.neighbors.forEach((neighbor) => {
          const destination = visibleById.get(neighbor.id);
          if (!destination || destination.id < panorama.id) return;
          const from = point(panorama);
          const to = point(destination);
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        });
      });

      visible.forEach((panorama) => {
        const position = point(panorama);
        const active = panorama.id === currentId;
        context.beginPath();
        context.arc(position.x, position.y, active ? 7 : 3.5, 0, Math.PI * 2);
        context.fillStyle = active ? "#ffffff" : "#48a3ff";
        context.fill();
        if (active) {
          context.beginPath();
          context.arc(position.x, position.y, 12, 0, Math.PI * 2);
          context.strokeStyle = "rgba(72, 163, 255, .75)";
          context.lineWidth = 3;
          context.stroke();
        }
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [currentId, visible]);

  const selectNearest = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - rect.left - 30) / (rect.width - 60);
    const normalizedY = (event.clientY - rect.top - 30) / (rect.height - 60);
    const nearest = visible.reduce<{ panorama: Panorama; distance: number } | null>(
      (best, panorama) => {
        const distance = Math.hypot(
          panorama.position.mapX - normalizedX,
          panorama.position.mapY - normalizedY,
        );
        if (!best || distance < best.distance) return { panorama, distance };
        return best;
      },
      null,
    );
    if (nearest && nearest.distance < 0.12) onSelect(nearest.panorama.id);
  };

  return (
    <div className="map-plot">
      <canvas
        ref={canvasRef}
        onClick={selectNearest}
        aria-label={`Plan des panoramas — ${FLOOR_LABELS[floor]}`}
      />
      <div className="map-scale"><span />5 m</div>
    </div>
  );
}

export default function Home() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const textureRef = useRef<THREE.Texture | null>(null);
  const activePanoRef = useRef<Panorama | null>(null);
  const hotspotRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const compassRef = useRef<HTMLSpanElement>(null);
  const lonRef = useRef(0);
  const latRef = useRef(0);
  const fovRef = useRef(82);
  const dragRef = useRef({ active: false, x: 0, y: 0, moved: false });

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [currentId, setCurrentId] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hotspotsVisible, setHotspotsVisible] = useState(true);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [toast, setToast] = useState("");
  const [mapFloor, setMapFloor] = useState(0);

  const currentPanorama = useMemo(
    () => manifest?.panoramas.find((panorama) => panorama.id === currentId) ?? null,
    [currentId, manifest],
  );

  const searchResults = useMemo(() => {
    if (!manifest || !query.trim()) return [];
    const needle = query.toLocaleLowerCase("fr");
    return manifest.panoramas
      .filter((panorama) =>
        `${panorama.label} ${panorama.area} ${FLOOR_LABELS[panorama.floor]}`
          .toLocaleLowerCase("fr")
          .includes(needle),
      )
      .slice(0, 7);
  }, [manifest, query]);

  useEffect(() => {
    let cancelled = false;
    fetch("/panoramas/manifest.json")
      .then((response) => {
        if (!response.ok) throw new Error("Manifest indisponible");
        return response.json() as Promise<Manifest>;
      })
      .then((data) => {
        if (cancelled) return;
        setManifest(data);
        const first = data.panoramas.find((panorama) => panorama.id === 0) ?? data.panoramas[0];
        setCurrentId(first.id);
        setMapFloor(first.floor);
      })
      .catch(() => setToast("Impossible de charger les panoramas."));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(fovRef.current, 1, 0.1, 300);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      "aria-label",
      "Panorama à 360 degrés. Faites glisser pour regarder autour de vous.",
    );
    viewport.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(100, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    materialRef.current = material;
    scene.add(new THREE.Mesh(geometry, material));
    const target = new THREE.Vector3();

    const resize = () => {
      const rect = viewport.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };

    const pointerDown = (event: PointerEvent) => {
      dragRef.current = { active: true, x: event.clientX, y: event.clientY, moved: false };
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.classList.add("is-dragging");
    };
    const pointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 2) drag.moved = true;
      lonRef.current -= dx * 0.14;
      latRef.current += dy * 0.11;
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const pointerUp = (event: PointerEvent) => {
      dragRef.current.active = false;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      renderer.domElement.classList.remove("is-dragging");
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      fovRef.current = Math.max(38, Math.min(95, fovRef.current + event.deltaY * 0.025));
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    };
    const keyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      if (event.key === "ArrowLeft") lonRef.current -= 4;
      if (event.key === "ArrowRight") lonRef.current += 4;
      if (event.key === "ArrowUp") latRef.current = Math.min(75, latRef.current + 3);
      if (event.key === "ArrowDown") latRef.current = Math.max(-75, latRef.current - 3);
      if (event.key === "+" || event.key === "=") fovRef.current = Math.max(38, fovRef.current - 5);
      if (event.key === "-") fovRef.current = Math.min(95, fovRef.current + 5);
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    };

    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", pointerUp);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keyDown);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      latRef.current = Math.max(-82, Math.min(82, latRef.current));
      const phi = THREE.MathUtils.degToRad(90 - latRef.current);
      const theta = THREE.MathUtils.degToRad(lonRef.current);
      target.set(
        100 * Math.sin(phi) * Math.cos(theta),
        100 * Math.cos(phi),
        100 * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(target);
      renderer.render(scene, camera);

      const rect = viewport.getBoundingClientRect();
      const panorama = activePanoRef.current;
      panorama?.neighbors.forEach((neighbor) => {
        const element = hotspotRefs.current[neighbor.id];
        if (!element) return;
        const difference = wrapAngle(neighbor.yaw - lonRef.current);
        const vertical = latRef.current - neighbor.pitch;
        const visible = Math.abs(difference) < camera.fov * 0.7 && Math.abs(vertical) < camera.fov * 0.58;
        if (!visible) {
          element.style.opacity = "0";
          element.style.pointerEvents = "none";
          return;
        }
        const x = rect.width / 2 + (difference / camera.fov) * rect.width * 0.82;
        const y = rect.height / 2 + (vertical / camera.fov) * rect.height * 0.9;
        element.style.opacity = "1";
        element.style.pointerEvents = "auto";
        element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      });
      if (compassRef.current) {
        compassRef.current.style.transform = `rotate(${-lonRef.current}deg)`;
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", keyDown);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerUp);
      renderer.domElement.removeEventListener("wheel", wheel);
      textureRef.current?.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      cameraRef.current = null;
      materialRef.current = null;
    };
  }, []);

  useEffect(() => {
    activePanoRef.current = currentPanorama;
    if (!currentPanorama || !materialRef.current) return;
    let cancelled = false;
    setTransitioning(true);
    const loader = new THREE.TextureLoader();
    loader.load(
      currentPanorama.image,
      (texture) => {
        if (cancelled) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        textureRef.current?.dispose();
        textureRef.current = texture;
        if (materialRef.current) {
          materialRef.current.map = texture;
          materialRef.current.needsUpdate = true;
        }
        lonRef.current = 0;
        latRef.current = 0;
        fovRef.current = 82;
        if (cameraRef.current) {
          cameraRef.current.fov = 82;
          cameraRef.current.updateProjectionMatrix();
        }
        setReady(true);
        setTransitioning(false);

        if (manifest) {
          currentPanorama.neighbors.forEach((neighbor) => {
            const nearby = manifest.panoramas.find((item) => item.id === neighbor.id);
            if (nearby) new Image().src = nearby.image;
          });
        }
      },
      undefined,
      () => {
        if (!cancelled) {
          setTransitioning(false);
          setToast("Ce panorama n’a pas pu être chargé.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentPanorama, manifest]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const goToPanorama = (id: number) => {
    const target = manifest?.panoramas.find((panorama) => panorama.id === id);
    if (!target || target.id === currentId) return;
    setCurrentId(target.id);
    setMapFloor(target.floor);
    setSearchOpen(false);
    setQuery("");
    setMeasurePoints([]);
  };

  const changeFloor = (floor: number) => {
    const onFloor = manifest?.panoramas.filter((panorama) => panorama.floor === floor) ?? [];
    setMapFloor(floor);
    if (!onFloor.length) {
      setToast("Aucun panorama sur ce niveau.");
      return;
    }
    const nearest = onFloor.reduce((best, panorama) => {
      if (!currentPanorama) return panorama;
      const bestDistance = Math.hypot(
        best.position.x - currentPanorama.position.x,
        best.position.y - currentPanorama.position.y,
      );
      const distance = Math.hypot(
        panorama.position.x - currentPanorama.position.x,
        panorama.position.y - currentPanorama.position.y,
      );
      return distance < bestDistance ? panorama : best;
    }, onFloor[0]);
    goToPanorama(nearest.id);
  };

  const zoom = (amount: number) => {
    fovRef.current = Math.max(38, Math.min(95, fovRef.current + amount));
    if (cameraRef.current) {
      cameraRef.current.fov = fovRef.current;
      cameraRef.current.updateProjectionMatrix();
    }
  };

  const resetView = () => {
    lonRef.current = 0;
    latRef.current = 0;
    fovRef.current = 82;
    zoom(0);
    setToast("Vue recentrée");
  };

  const handleStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!measureMode || dragRef.current.moved) return;
    if ((event.target as HTMLElement).closest("button, input, aside, [role='dialog']")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setMeasurePoints((points) => (points.length >= 2 ? [point] : [...points, point]));
  };

  const measurementStyle = useMemo<CSSProperties | null>(() => {
    if (measurePoints.length !== 2) return null;
    const [first, second] = measurePoints;
    const length = Math.hypot(second.x - first.x, second.y - first.y);
    const angle = Math.atan2(second.y - first.y, second.x - first.x) * (180 / Math.PI);
    return {
      width: length,
      left: first.x,
      top: first.y,
      transform: `rotate(${angle}deg)`,
    };
  }, [measurePoints]);

  const toggleMeasure = () => {
    setMeasureMode((active) => !active);
    setMeasurePoints([]);
    setMenuOpen(false);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setToast("Lien de la visite copié");
    setMenuOpen(false);
  };

  const requestFullscreen = async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  };

  const floorCounts = useMemo(() => {
    const counts = new Map<number, number>();
    manifest?.panoramas.forEach((panorama) => counts.set(panorama.floor, (counts.get(panorama.floor) ?? 0) + 1));
    return counts;
  }, [manifest]);

  return (
    <main
      className={`tour-shell ${measureMode ? "measure-mode" : ""}`}
      onClick={handleStageClick}
    >
      <div ref={viewportRef} className="panorama-viewport" />
      <div className="viewer-vignette" aria-hidden="true" />
      <div className={`scene-transition ${transitioning ? "is-visible" : ""}`} />

      {!ready && (
        <div className="loading-screen">
          <div className="loader-mark"><span>A</span><small>360</small></div>
          <div className="loading-line"><span /></div>
          <p>Préparation de la visite d’Arnex…</p>
        </div>
      )}

      <header className="topbar">
        <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="Ouvrir le menu">
          <span className="hamburger" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <div className="search-wrap">
          <span className="search-mark" aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            placeholder={`Rechercher dans ${manifest?.site.name ?? "la visite"}`}
            aria-label="Rechercher un point de vue"
          />
          {query && <button className="clear-search" onClick={() => setQuery("")} aria-label="Effacer la recherche">×</button>}
        </div>
        <button className="icon-button" onClick={() => goToPanorama(0)} aria-label="Aller au point de départ">
          <span className="pin-icon" aria-hidden="true" />
        </button>
      </header>

      {searchOpen && (
        <section className="search-panel" aria-label="Résultats de recherche">
          <div className="search-panel-head">
            <span>{query ? `${searchResults.length} résultat${searchResults.length > 1 ? "s" : ""}` : "Points de vue"}</span>
            <button onClick={() => setSearchOpen(false)} aria-label="Fermer">×</button>
          </div>
          <div className="search-results">
            {(query ? searchResults : manifest?.panoramas.slice(0, 6) ?? []).map((panorama) => (
              <button key={panorama.id} onClick={() => goToPanorama(panorama.id)}>
                <span className="result-index">{String(panorama.id).padStart(2, "0")}</span>
                <span><strong>{panorama.area}</strong><small>{FLOOR_LABELS[panorama.floor]} · altitude {panorama.position.z.toFixed(1)} m</small></span>
              </button>
            ))}
            {query && searchResults.length === 0 && <p className="empty-state">Aucun point de vue trouvé.</p>}
          </div>
        </section>
      )}

      {hotspotsVisible && currentPanorama?.neighbors.map((neighbor) => {
        const destination = manifest?.panoramas.find((item) => item.id === neighbor.id);
        if (!destination) return null;
        return (
          <button
            key={neighbor.id}
            ref={(element) => { hotspotRefs.current[neighbor.id] = element; }}
            className="nav-hotspot"
            onClick={(event) => { event.stopPropagation(); goToPanorama(neighbor.id); }}
            aria-label={`Aller vers ${destination.label}, à ${neighbor.distance} mètres`}
          >
            <span className="hotspot-arrow">⌃</span>
            <span className="hotspot-label">{neighbor.distance} m</span>
          </button>
        );
      })}

      <aside className={`side-drawer ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="drawer-head">
          <div className="brand-lockup"><span>A</span><div><strong>Arnex 360</strong><small>Visite immersive</small></div></div>
          <button onClick={() => setMenuOpen(false)} aria-label="Fermer le menu">×</button>
        </div>
        <div className="drawer-place">
          <span className="place-dot" />
          <div><small>Site actuel</small><strong>{manifest?.site.name ?? "Gare d’Arnex"}</strong></div>
        </div>
        <nav>
          <p>Visite</p>
          <button onClick={() => { setMapOpen(true); setMenuOpen(false); }}><span>▦</span><div><strong>Plan des parcours</strong><small>{manifest?.site.panoramaCount ?? 45} points géolocalisés</small></div></button>
          <button onClick={() => { setHotspotsVisible((visible) => !visible); setMenuOpen(false); }}><span>◉</span><div><strong>Points de déplacement</strong><small>{hotspotsVisible ? "Masquer les flèches" : "Afficher les flèches"}</small></div></button>
          <button onClick={resetView}><span>⌖</span><div><strong>Recentrer la vue</strong><small>Orientation et zoom d’origine</small></div></button>
          <p>Outils</p>
          <button className={measureMode ? "is-active" : ""} onClick={toggleMeasure}><span>⌁</span><div><strong>Mesurer à l’écran</strong><small>Placer deux repères</small></div></button>
          <button onClick={copyLink}><span>↗</span><div><strong>Partager la visite</strong><small>Copier un lien</small></div></button>
          <button onClick={requestFullscreen}><span>⛶</span><div><strong>Plein écran</strong><small>Masquer l’interface du navigateur</small></div></button>
          <p>Données</p>
          <div className="data-summary"><span>{manifest?.site.panoramaCount ?? 45}</span><small>panoramas<br />8192 × 4096 source</small></div>
        </nav>
      </aside>
      {menuOpen && <button className="drawer-scrim" onClick={() => setMenuOpen(false)} aria-label="Fermer le menu" />}

      <div className="floor-rail" aria-label="Choisir un niveau">
        {[2, 1, 0, -1].map((floor) => (
          <button
            key={floor}
            className={currentPanorama?.floor === floor ? "is-current" : ""}
            onClick={() => changeFloor(floor)}
            aria-label={`${FLOOR_LABELS[floor]}, ${floorCounts.get(floor) ?? 0} panoramas`}
          >
            <span>{floor}</span><small>{floorCounts.get(floor) ?? 0}</small>
          </button>
        ))}
      </div>

      <section className="location-card">
        <span className="location-index">{String(currentId).padStart(2, "0")}</span>
        <div><strong>{currentPanorama?.area ?? "Chargement"}</strong><small>{currentPanorama ? `${FLOOR_LABELS[currentPanorama.floor]} · ${currentPanorama.position.z.toFixed(1)} m` : "Coordonnées en préparation"}</small></div>
      </section>

      <div className="brand-badge"><span>A</span><small>360</small></div>
      <div className="capture-date">{manifest?.site.captured ?? "12 août 2025"}</div>

      <div className="view-controls">
        <button onClick={() => zoom(-8)} aria-label="Zoomer">+</button>
        <button onClick={() => zoom(8)} aria-label="Dézoomer">−</button>
        <button className="compass-button" onClick={resetView} aria-label="Recentrer vers le nord"><span ref={compassRef}>▲</span><small>N</small></button>
        <button className={mapOpen ? "is-active" : ""} onClick={() => setMapOpen((open) => !open)} aria-label="Afficher le plan"><span className="map-glyph">▦</span></button>
      </div>

      {mapOpen && manifest && (
        <section className="map-panel" role="dialog" aria-label="Plan de la visite">
          <div className="map-panel-head">
            <div><small>Structure du site</small><strong>{manifest.site.name}</strong></div>
            <button onClick={() => setMapOpen(false)} aria-label="Fermer le plan">×</button>
          </div>
          <div className="map-floor-tabs">
            {[2, 1, 0, -1].map((floor) => (
              <button key={floor} className={mapFloor === floor ? "is-active" : ""} onClick={() => setMapFloor(floor)}>
                {FLOOR_LABELS[floor]} <span>{floorCounts.get(floor) ?? 0}</span>
              </button>
            ))}
          </div>
          <MapPlot panoramas={manifest.panoramas} currentId={currentId} floor={mapFloor} onSelect={goToPanorama} />
          <div className="map-panel-foot"><span><i className="legend-current" />Position actuelle</span><span><i />Point disponible</span></div>
        </section>
      )}

      {measureMode && (
        <div className="measure-banner"><strong>Mesure rapide</strong><span>Cliquez deux points dans l’image</span><button onClick={toggleMeasure}>Terminer</button></div>
      )}
      {measurePoints.map((point, index) => <span key={`${point.x}-${point.y}`} className="measure-point" style={{ left: point.x, top: point.y }}>{index + 1}</span>)}
      {measurementStyle && <><span className="measure-line" style={measurementStyle} /><span className="measure-value" style={{ left: (measurePoints[0].x + measurePoints[1].x) / 2, top: (measurePoints[0].y + measurePoints[1].y) / 2 }}>{(Math.hypot(measurePoints[1].x - measurePoints[0].x, measurePoints[1].y - measurePoints[0].y) / 82).toFixed(1)} m*</span></>}

      <div className="interaction-hint"><span className="mouse-shape" />Glisser pour regarder · molette pour zoomer</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
