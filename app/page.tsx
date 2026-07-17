"use client";

import * as THREE from "three";
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";

type Neighbor = {
  id: number;
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
  orientation: {
    w: number;
    x: number;
    y: number;
    z: number;
  };
  neighbors: Neighbor[];
};

type Manifest = {
  site: {
    name: string;
    captured: string;
    panoramaCount: number;
  };
  panoramas: Panorama[];
};

function wrapAngle(angle: number) {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

const MARKER_HEIGHT_METERS = 1.65;

function vectorBetweenPanoramas(from: Panorama, to: Panorama, onFloor: boolean) {
  const vector = new THREE.Vector3(
    to.position.x - from.position.x,
    to.position.y - from.position.y,
    to.position.z - from.position.z - (onFloor ? MARKER_HEIGHT_METERS : 0),
  );
  const inverseOrientation = new THREE.Quaternion(
    from.orientation.x,
    from.orientation.y,
    from.orientation.z,
    from.orientation.w,
  ).normalize().invert();

  // NavVis pose axes are X forward, Y right and Z up. The equirectangular
  // raster used here faces -X at its horizontal centre, so this proper 3D
  // basis change (determinant +1) maps a local pose vector into the viewer.
  vector.applyQuaternion(inverseOrientation);
  return new THREE.Vector3(-vector.x, vector.z, vector.y);
}

function viewAngles(from: Panorama, to: Panorama) {
  const vector = vectorBetweenPanoramas(from, to, false);
  return {
    yaw: THREE.MathUtils.radToDeg(Math.atan2(vector.z, vector.x)),
    pitch: THREE.MathUtils.radToDeg(Math.atan2(vector.y, Math.hypot(vector.x, vector.z))),
  };
}

function MapPlot({
  panoramas,
  currentId,
  onSelect,
}: {
  panoramas: Panorama[];
  currentId: number;
  onSelect: (id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

      context.strokeStyle = "rgba(109, 131, 153, .16)";
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
      const byId = new Map(panoramas.map((item) => [item.id, item]));

      context.lineCap = "round";
      context.lineWidth = 2.5;
      context.strokeStyle = "rgba(52, 143, 240, .34)";
      panoramas.forEach((panorama) => {
        panorama.neighbors.forEach((neighbor) => {
          const destination = byId.get(neighbor.id);
          if (!destination || destination.id < panorama.id) return;
          const from = point(panorama);
          const to = point(destination);
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        });
      });

      panoramas.forEach((panorama) => {
        const position = point(panorama);
        const active = panorama.id === currentId;
        context.beginPath();
        context.arc(position.x, position.y, active ? 7 : 3.2, 0, Math.PI * 2);
        context.fillStyle = active ? "#ffffff" : "#48a3ff";
        context.fill();
        if (active) {
          context.beginPath();
          context.arc(position.x, position.y, 12, 0, Math.PI * 2);
          context.strokeStyle = "rgba(72, 163, 255, .8)";
          context.lineWidth = 3;
          context.stroke();
        }
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [currentId, panoramas]);

  const selectNearest = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - rect.left - 30) / (rect.width - 60);
    const normalizedY = (event.clientY - rect.top - 30) / (rect.height - 60);
    const nearest = panoramas.reduce<{ panorama: Panorama; distance: number } | null>(
      (best, panorama) => {
        const distance = Math.hypot(
          panorama.position.mapX - normalizedX,
          panorama.position.mapY - normalizedY,
        );
        return !best || distance < best.distance ? { panorama, distance } : best;
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
        aria-label="Plan de tous les panoramas"
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
  const panoramasByIdRef = useRef<Map<number, Panorama>>(new Map());
  const previousPanoRef = useRef<number | null>(null);
  const hotspotRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const compassRef = useRef<HTMLSpanElement>(null);
  const lonRef = useRef(0);
  const latRef = useRef(0);
  const fovRef = useRef(82);
  const dragRef = useRef({ active: false, x: 0, y: 0 });

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [currentId, setCurrentId] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [hotspotsVisible, setHotspotsVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [toast, setToast] = useState("");

  const currentPanorama = useMemo(
    () => manifest?.panoramas.find((panorama) => panorama.id === currentId) ?? null,
    [currentId, manifest],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/panoramas/manifest.json")
      .then((response) => {
        if (!response.ok) throw new Error("Manifest indisponible");
        return response.json() as Promise<Manifest>;
      })
      .then((data) => {
        if (cancelled) return;
        panoramasByIdRef.current = new Map(data.panoramas.map((panorama) => [panorama.id, panorama]));
        setManifest(data);
        setCurrentId(data.panoramas[0]?.id ?? 0);
      })
      .catch(() => setToast("Impossible de charger les panoramas."));
    return () => { cancelled = true; };
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
    const cameraDirection = new THREE.Vector3();
    const hotspotDirection = new THREE.Vector3();
    const projectedHotspot = new THREE.Vector3();

    const resize = () => {
      const rect = viewport.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };

    const pointerDown = (event: PointerEvent) => {
      dragRef.current = { active: true, x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.classList.add("is-dragging");
    };
    const pointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active) return;
      lonRef.current -= (event.clientX - drag.x) * 0.14;
      latRef.current += (event.clientY - drag.y) * 0.11;
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
      camera.getWorldDirection(cameraDirection);
      const activePanorama = activePanoRef.current;
      activePanorama?.neighbors.forEach((neighbor) => {
        const element = hotspotRefs.current[neighbor.id];
        if (!element) return;
        const destination = panoramasByIdRef.current.get(neighbor.id);
        if (!destination) return;

        hotspotDirection.copy(vectorBetweenPanoramas(activePanorama, destination, true)).normalize();
        const inFront = cameraDirection.dot(hotspotDirection) > 0.04;
        projectedHotspot.copy(hotspotDirection).multiplyScalar(80).project(camera);
        const inView = inFront
          && Math.abs(projectedHotspot.x) < 1.08
          && Math.abs(projectedHotspot.y) < 1.08;

        if (!inView) {
          element.style.opacity = "0";
          element.style.pointerEvents = "none";
          return;
        }

        const x = (projectedHotspot.x * 0.5 + 0.5) * rect.width;
        const y = (-projectedHotspot.y * 0.5 + 0.5) * rect.height;
        const distance = Math.hypot(
          destination.position.x - activePanorama.position.x,
          destination.position.y - activePanorama.position.y,
          destination.position.z - activePanorama.position.z,
        );
        const distanceScale = Math.max(0.78, Math.min(1.08, 1.12 - distance * 0.03));
        const zoomScale = Math.max(0.84, Math.min(1.28, 82 / camera.fov));
        const scale = distanceScale * zoomScale;
        element.style.setProperty("--hotspot-scale", scale.toFixed(3));
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
        const routeNeighbors = currentPanorama.neighbors;
        const arrival = currentPanorama.neighbors.find((neighbor) => neighbor.id === previousPanoRef.current);
        const onwardNeighbors = routeNeighbors.filter((neighbor) => neighbor.id !== previousPanoRef.current);
        let initialNeighbor = routeNeighbors[0];
        if (arrival && onwardNeighbors.length) {
          const arrivalPanorama = panoramasByIdRef.current.get(arrival.id);
          const arrivalYaw = arrivalPanorama ? viewAngles(currentPanorama, arrivalPanorama).yaw : 0;
          const onwardYaw = wrapAngle(arrivalYaw + 180);
          initialNeighbor = [...onwardNeighbors].sort(
            (a, b) => {
              const panoramaA = panoramasByIdRef.current.get(a.id);
              const panoramaB = panoramasByIdRef.current.get(b.id);
              const yawA = panoramaA ? viewAngles(currentPanorama, panoramaA).yaw : 0;
              const yawB = panoramaB ? viewAngles(currentPanorama, panoramaB).yaw : 0;
              return Math.abs(wrapAngle(yawA - onwardYaw)) - Math.abs(wrapAngle(yawB - onwardYaw));
            },
          )[0];
        } else if (arrival) {
          initialNeighbor = arrival;
        }
        const initialPanorama = initialNeighbor
          ? panoramasByIdRef.current.get(initialNeighbor.id)
          : null;
        const initialView = initialPanorama
          ? viewAngles(currentPanorama, initialPanorama)
          : { yaw: 0, pitch: 0 };
        lonRef.current = initialView.yaw;
        latRef.current = Math.min(24, initialView.pitch + 2);
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
    return () => { cancelled = true; };
  }, [currentPanorama, manifest]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const goToPanorama = (id: number) => {
    const target = manifest?.panoramas.find((panorama) => panorama.id === id);
    if (!target || target.id === currentId) return;
    previousPanoRef.current = currentId;
    setCurrentId(target.id);
    setMapOpen(false);
  };

  const zoom = (amount: number) => {
    fovRef.current = Math.max(38, Math.min(95, fovRef.current + amount));
    if (cameraRef.current) {
      cameraRef.current.fov = fovRef.current;
      cameraRef.current.updateProjectionMatrix();
    }
  };

  const resetView = () => {
    const nextId = currentPanorama?.neighbors[0]?.id;
    const nextPanorama = nextId === undefined ? null : panoramasByIdRef.current.get(nextId);
    const direction = currentPanorama && nextPanorama
      ? viewAngles(currentPanorama, nextPanorama)
      : { yaw: 0, pitch: 0 };
    lonRef.current = direction.yaw;
    latRef.current = direction.pitch;
    fovRef.current = 82;
    zoom(0);
    setToast("Vue recentrée vers le prochain point");
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

  return (
    <main className="tour-shell">
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

      <header className="topbar minimal-topbar">
        <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="Ouvrir le menu">
          <span className="hamburger" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <div className="site-title">
          <strong>Arnex 360</strong>
          <small>{currentPanorama?.area ?? "Visite immersive"}</small>
        </div>
      </header>

      {hotspotsVisible && currentPanorama?.neighbors.map((neighbor) => {
        const destination = manifest?.panoramas.find((item) => item.id === neighbor.id);
        if (!destination) return null;
        return (
          <button
            key={neighbor.id}
            ref={(element) => { hotspotRefs.current[neighbor.id] = element; }}
            className="nav-hotspot"
            onClick={() => goToPanorama(neighbor.id)}
            aria-label={`Avancer vers le panorama ${neighbor.id}`}
          >
            <span className="hotspot-disc" aria-hidden="true">
              <span className="hotspot-chevron" />
            </span>
          </button>
        );
      })}

      <aside className={`side-drawer compact-drawer ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="drawer-head">
          <div className="brand-lockup"><span>A</span><div><strong>Arnex 360</strong><small>Visite immersive</small></div></div>
          <button onClick={() => setMenuOpen(false)} aria-label="Fermer le menu">×</button>
        </div>
        <div className="drawer-place">
          <span className="place-dot" />
          <div><small>Site actuel</small><strong>{manifest?.site.name ?? "Gare d’Arnex"}</strong></div>
        </div>
        <nav>
          <button onClick={() => { setMapOpen(true); setMenuOpen(false); }}><span>▦</span><div><strong>Plan du parcours</strong><small>{manifest?.site.panoramaCount ?? 45} panoramas</small></div></button>
          <button onClick={() => { setHotspotsVisible((visible) => !visible); setMenuOpen(false); }}><span>◉</span><div><strong>Hotspots</strong><small>{hotspotsVisible ? "Masquer les flèches" : "Afficher les flèches"}</small></div></button>
          <button onClick={() => { resetView(); setMenuOpen(false); }}><span>⌖</span><div><strong>Recentrer la vue</strong><small>Regarder vers le prochain point</small></div></button>
          <button onClick={copyLink}><span>↗</span><div><strong>Partager</strong><small>Copier le lien de la visite</small></div></button>
          <button onClick={requestFullscreen}><span>⛶</span><div><strong>Plein écran</strong><small>Masquer le navigateur</small></div></button>
        </nav>
      </aside>
      {menuOpen && <button className="drawer-scrim" onClick={() => setMenuOpen(false)} aria-label="Fermer le menu" />}

      <section className="location-card simple-location">
        <span className="location-index">{String(currentId).padStart(2, "0")}</span>
        <div><strong>{currentPanorama?.area ?? "Chargement"}</strong><small>{manifest?.site.captured ?? "12 août 2025"}</small></div>
      </section>

      <div className="view-controls simplified-controls">
        <button onClick={() => zoom(-8)} aria-label="Zoomer">+</button>
        <button onClick={() => zoom(8)} aria-label="Dézoomer">−</button>
        <button className="compass-button" onClick={resetView} aria-label="Recentrer la vue"><span ref={compassRef}>▲</span><small>N</small></button>
        <button className={mapOpen ? "is-active" : ""} onClick={() => setMapOpen((open) => !open)} aria-label="Afficher le plan"><span className="map-glyph">▦</span></button>
      </div>

      {mapOpen && manifest && (
        <section className="map-panel simplified-map" role="dialog" aria-label="Plan de la visite">
          <div className="map-panel-head">
            <div><small>Parcours complet</small><strong>{manifest.site.name}</strong></div>
            <button onClick={() => setMapOpen(false)} aria-label="Fermer le plan">×</button>
          </div>
          <MapPlot panoramas={manifest.panoramas} currentId={currentId} onSelect={goToPanorama} />
          <div className="map-panel-foot"><span><i className="legend-current" />Position actuelle</span><span><i />Point disponible</span></div>
        </section>
      )}

      <div className="interaction-hint"><span className="mouse-shape" />Glisser pour regarder · cliquer sur une flèche pour avancer</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
