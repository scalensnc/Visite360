"use client";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { loadPanoramaFolder, type Manifest, type Panorama } from "./panorama-folder";

function wrapAngle(angle: number) {
  return ((angle + 180) % 360 + 360) % 360 - 180;
}

const MARKER_HEIGHT_METERS = 1.65;
const MIN_VISIBLE_RADIUS_METERS = 2;
const MAX_VISIBLE_RADIUS_METERS = 30;
const DEFAULT_VISIBLE_RADIUS_METERS = 5;
const VISIBLE_RADIUS_STORAGE_KEY = "panorama360.visibleRadiusMeters";
const DIRECTORY_PICKER_ATTRIBUTES = {
  webkitdirectory: "",
} as unknown as InputHTMLAttributes<HTMLInputElement>;
const DATASET_UP = new THREE.Vector3(0, 0, 1);
const VIEWER_UP = new THREE.Vector3(0, 1, 0);
const levelingCache = new WeakMap<Panorama, THREE.Quaternion>();

type TourPointer = {
  manifest: string;
  release?: string;
};

function initialManifestUrl() {
  const tourMatch = window.location.pathname.match(/^\/v\/([a-z0-9][a-z0-9-]*)\/?$/i);
  if (!tourMatch) return Promise.resolve<string | null>(null);

  const slug = tourMatch[1].toLocaleLowerCase();
  return fetch(`/tours/${encodeURIComponent(slug)}/current.json`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`Visite ${slug} introuvable`);
      return response.json() as Promise<TourPointer>;
    })
    .then((pointer) => {
      if (!pointer.manifest || !pointer.manifest.endsWith("/manifest.json")) {
        throw new Error("Le pointeur de visite est invalide");
      }
      return new URL(pointer.manifest, window.location.origin).toString();
    });
}

function navvisLocalToViewer(vector: THREE.Vector3) {
  return new THREE.Vector3(-vector.x, vector.z, vector.y);
}

function levelingQuaternion(panorama: Panorama) {
  const cached = levelingCache.get(panorama);
  if (cached) return cached;

  const inverseOrientation = new THREE.Quaternion(
    panorama.orientation.x,
    panorama.orientation.y,
    panorama.orientation.z,
    panorama.orientation.w,
  ).normalize().invert();
  const worldUpInPanorama = DATASET_UP.clone().applyQuaternion(inverseOrientation);
  const worldUpInViewer = navvisLocalToViewer(worldUpInPanorama).normalize();
  const correction = new THREE.Quaternion().setFromUnitVectors(worldUpInViewer, VIEWER_UP);
  levelingCache.set(panorama, correction);
  return correction;
}

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
  return navvisLocalToViewer(vector).applyQuaternion(levelingQuaternion(from));
}

function viewAngles(from: Panorama, to: Panorama) {
  const vector = vectorBetweenPanoramas(from, to, false);
  return {
    yaw: THREE.MathUtils.radToDeg(Math.atan2(vector.z, vector.x)),
    pitch: THREE.MathUtils.radToDeg(Math.atan2(vector.y, Math.hypot(vector.x, vector.z))),
  };
}

function distanceBetweenPanoramas(from: Panorama, to: Panorama) {
  return Math.hypot(
    to.position.x - from.position.x,
    to.position.y - from.position.y,
    to.position.z - from.position.z,
  );
}

function hotspotPerspectiveScale(distanceMeters: number, fieldOfView: number) {
  const distanceScale = THREE.MathUtils.clamp(
    Math.pow(5 / Math.max(distanceMeters, 2.5), 0.48),
    0.44,
    1.42,
  );
  const zoomScale = THREE.MathUtils.clamp(82 / fieldOfView, 0.82, 1.25);
  return THREE.MathUtils.clamp(distanceScale * zoomScale, 0.38, 1.7);
}

function hotspotPerspectiveOpacity(distanceMeters: number) {
  return THREE.MathUtils.clamp(1.06 - distanceMeters / 85, 0.68, 1);
}

const MAP_VERTICAL_SCALE = 1.6;
const MAP_FLOOR_COLORS = new Map([
  [-1, 0x8aa5ff],
  [0, 0x48a3ff],
  [1, 0x63d8b3],
  [2, 0xf4bd59],
]);

function MapScene({
  panoramas,
  currentId,
  onSelect,
}: {
  panoramas: Panorama[];
  currentId: number;
  onSelect: (id: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const resetViewRef = useRef<() => void>(() => undefined);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const hoveredPanorama = hoveredId === null
    ? null
    : panoramas.find((panorama) => panorama.id === hoveredId) ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || panoramas.length === 0) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1722);
    scene.fog = new THREE.FogExp2(0x0a1722, 0.016);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "application");
    renderer.domElement.setAttribute(
      "aria-label",
      "Carte 3D du parcours. Faites glisser pour tourner, utilisez la molette pour zoomer et cliquez sur un point pour ouvrir son panorama.",
    );
    container.prepend(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minPolarAngle = THREE.MathUtils.degToRad(14);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
    controls.listenToKeyEvents(renderer.domElement);

    const minX = Math.min(...panoramas.map((panorama) => panorama.position.x));
    const maxX = Math.max(...panoramas.map((panorama) => panorama.position.x));
    const minY = Math.min(...panoramas.map((panorama) => panorama.position.y));
    const maxY = Math.max(...panoramas.map((panorama) => panorama.position.y));
    const minZ = Math.min(...panoramas.map((panorama) => panorama.position.z));
    const maxZ = Math.max(...panoramas.map((panorama) => panorama.position.z));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const mapPosition = (panorama: Panorama) => new THREE.Vector3(
      panorama.position.x - centerX,
      (panorama.position.z - minZ) * MAP_VERTICAL_SCALE,
      panorama.position.y - centerY,
    );
    const sceneSpan = Math.max(maxX - minX, maxY - minY, (maxZ - minZ) * MAP_VERTICAL_SCALE, 12);
    const target = new THREE.Vector3(0, (maxZ - minZ) * MAP_VERTICAL_SCALE * 0.32, 0);
    const initialCameraPosition = new THREE.Vector3(sceneSpan * 0.88, sceneSpan * 0.78, sceneSpan * 0.92);
    const resetView = () => {
      camera.position.copy(initialCameraPosition);
      controls.target.copy(target);
      controls.update();
    };
    resetViewRef.current = resetView;
    controls.minDistance = sceneSpan * 0.3;
    controls.maxDistance = sceneSpan * 3.2;
    resetView();

    scene.add(new THREE.HemisphereLight(0xc7e4ff, 0x102337, 1.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(sceneSpan, sceneSpan * 1.4, sceneSpan * 0.5);
    scene.add(keyLight);

    const floorGroups = new Map<number, Panorama[]>();
    panoramas.forEach((panorama) => {
      const group = floorGroups.get(panorama.floor) ?? [];
      group.push(panorama);
      floorGroups.set(panorama.floor, group);
    });
    floorGroups.forEach((floorPanoramas, floor) => {
      const color = MAP_FLOOR_COLORS.get(floor) ?? 0x48a3ff;
      const grid = new THREE.GridHelper(sceneSpan + 8, 18, color, color);
      const gridMaterial = grid.material as THREE.Material;
      gridMaterial.transparent = true;
      gridMaterial.opacity = floor === 0 ? 0.18 : 0.1;
      grid.position.y = floorPanoramas.reduce(
        (sum, panorama) => sum + mapPosition(panorama).y,
        0,
      ) / floorPanoramas.length - 0.28;
      scene.add(grid);
    });

    const byId = new Map(panoramas.map((panorama) => [panorama.id, panorama]));
    const routeVertices: number[] = [];
    panoramas.forEach((panorama) => {
      panorama.neighbors.forEach((neighbor) => {
        const destination = byId.get(neighbor.id);
        if (!destination || destination.id < panorama.id) return;
        const from = mapPosition(panorama);
        const to = mapPosition(destination);
        routeVertices.push(from.x, from.y, from.z, to.x, to.y, to.z);
      });
    });
    const routeGeometry = new THREE.BufferGeometry();
    routeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(routeVertices, 3));
    const routeMaterial = new THREE.LineBasicMaterial({
      color: 0x75bbff,
      transparent: true,
      opacity: 0.52,
    });
    scene.add(new THREE.LineSegments(routeGeometry, routeMaterial));

    const pointGeometry = new THREE.SphereGeometry(0.42, 18, 12);
    const pointMaterials = new Map<number, THREE.MeshStandardMaterial>();
    const pointMeshes: THREE.Mesh[] = [];
    panoramas.forEach((panorama) => {
      const color = MAP_FLOOR_COLORS.get(panorama.floor) ?? 0x48a3ff;
      let material = pointMaterials.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.22,
          roughness: 0.36,
          metalness: 0.12,
        });
        pointMaterials.set(color, material);
      }
      const mesh = new THREE.Mesh(pointGeometry, material);
      mesh.position.copy(mapPosition(panorama));
      mesh.userData.panoramaId = panorama.id;
      mesh.userData.baseScale = panorama.id === currentId ? 1.55 : 1;
      mesh.scale.setScalar(mesh.userData.baseScale);
      scene.add(mesh);
      pointMeshes.push(mesh);
    });

    const currentPanorama = byId.get(currentId);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const currentRing = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.92, 40), ringMaterial);
    currentRing.rotation.x = -Math.PI / 2;
    if (currentPanorama) {
      currentRing.position.copy(mapPosition(currentPanorama));
      currentRing.position.y -= 0.05;
      scene.add(currentRing);
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredMesh: THREE.Mesh | null = null;
    let pointerStart = { x: 0, y: 0 };
    const panoramaAtPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(pointMeshes, false)[0]?.object as THREE.Mesh | undefined;
    };
    const setHoveredMesh = (mesh: THREE.Mesh | null) => {
      if (mesh === hoveredMesh) return;
      if (hoveredMesh) hoveredMesh.scale.setScalar(hoveredMesh.userData.baseScale);
      hoveredMesh = mesh;
      if (hoveredMesh) hoveredMesh.scale.setScalar(hoveredMesh.userData.baseScale * 1.42);
      renderer.domElement.classList.toggle("is-point-hovered", Boolean(hoveredMesh));
      setHoveredId(hoveredMesh ? Number(hoveredMesh.userData.panoramaId) : null);
    };
    const pointerMove = (event: PointerEvent) => setHoveredMesh(panoramaAtPointer(event) ?? null);
    const pointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const mesh = panoramaAtPointer(event);
      if (mesh) onSelectRef.current(Number(mesh.userData.panoramaId));
    };
    const pointerLeave = () => setHoveredMesh(null);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointerleave", pointerLeave);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    let frame = 0;
    const animate = (time: number) => {
      frame = requestAnimationFrame(animate);
      controls.update();
      const pulse = 1 + Math.sin(time * 0.004) * 0.12;
      currentRing.scale.setScalar(pulse);
      ringMaterial.opacity = 0.68 + Math.sin(time * 0.004) * 0.16;
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.stopListenToKeyEvents();
      controls.dispose();
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      resetViewRef.current = () => undefined;
    };
  }, [currentId, panoramas]);

  return (
    <div ref={containerRef} className="map-plot map-scene">
      <div className="map-orbit-hint">
        <span className="map-orbit-hint-desktop">Glisser pour tourner · clic droit pour déplacer · molette pour zoomer</span>
        <span className="map-orbit-hint-mobile">Glisser · pincer · toucher un point</span>
      </div>
      <button className="map-reset-view" onClick={() => resetViewRef.current()} aria-label="Réinitialiser la vue 3D">
        Vue 3D
      </button>
      {hoveredPanorama && (
        <button className="map-point-preview" onClick={() => onSelect(hoveredPanorama.id)}>
          <span>Panorama {String(hoveredPanorama.id).padStart(2, "0")}</span>
          <strong>{hoveredPanorama.area}</strong>
          <small>Ouvrir ce point →</small>
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const panoramaMeshRef = useRef<THREE.Mesh | null>(null);
  const textureRef = useRef<THREE.Texture | null>(null);
  const activePanoRef = useRef<Panorama | null>(null);
  const panoramasByIdRef = useRef<Map<number, Panorama>>(new Map());
  const previousPanoRef = useRef<number | null>(null);
  const hotspotRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const compassRef = useRef<HTMLSpanElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderLoadIdRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);
  const lonRef = useRef(0);
  const latRef = useRef(0);
  const fovRef = useRef(82);
  const dragRef = useRef({ active: false, x: 0, y: 0 });

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [currentId, setCurrentId] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [hotspotsVisible, setHotspotsVisible] = useState(true);
  const [visibleRadiusMeters, setVisibleRadiusMeters] = useState(DEFAULT_VISIBLE_RADIUS_METERS);
  const [ready, setReady] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [toast, setToast] = useState("");
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [datasetError, setDatasetError] = useState("");

  const currentPanorama = useMemo(
    () => manifest?.panoramas.find((panorama) => panorama.id === currentId) ?? null,
    [currentId, manifest],
  );
  const visiblePanoramas = useMemo(() => {
    if (!manifest || !currentPanorama) return [];

    return manifest.panoramas
      .filter((panorama) => (
        panorama.id !== currentPanorama.id
        && distanceBetweenPanoramas(currentPanorama, panorama) <= visibleRadiusMeters
      ))
      .sort((a, b) => (
        distanceBetweenPanoramas(currentPanorama, a)
        - distanceBetweenPanoramas(currentPanorama, b)
      ));
  }, [currentPanorama, manifest, visibleRadiusMeters]);

  useEffect(() => {
    let cancelled = false;
    const savedRadius = Number(window.localStorage.getItem(VISIBLE_RADIUS_STORAGE_KEY));
    if (Number.isInteger(savedRadius) && savedRadius >= MIN_VISIBLE_RADIUS_METERS && savedRadius <= MAX_VISIBLE_RADIUS_METERS) {
      queueMicrotask(() => {
        if (!cancelled) setVisibleRadiusMeters(savedRadius);
      });
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const loadId = ++folderLoadIdRef.current;
    const loadInitialTour = async () => {
      try {
        const manifestUrl = await initialManifestUrl();
        if (!manifestUrl || folderLoadIdRef.current !== loadId) return;
        setDatasetLoading(true);
        const response = await fetch(manifestUrl);
        if (!response.ok) throw new Error("Manifest indisponible");
        const data = await response.json() as Manifest;
        if (folderLoadIdRef.current !== loadId) return;
        panoramasByIdRef.current = new Map(data.panoramas.map((panorama) => [panorama.id, panorama]));
        setManifest(data);
        setCurrentId(data.panoramas[0]?.id ?? 0);
        setDatasetLoading(false);
      } catch (error: unknown) {
        if (folderLoadIdRef.current !== loadId) return;
        setDatasetLoading(false);
        setDatasetError(error instanceof Error
          ? error.message
          : "La visite publiée n’a pas pu être chargée.");
      }
    };
    void loadInitialTour();
    return () => {
      if (folderLoadIdRef.current === loadId) folderLoadIdRef.current += 1;
    };
  }, []);

  useEffect(() => () => {
    folderLoadIdRef.current += 1;
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
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
    const panoramaMesh = new THREE.Mesh(geometry, material);
    panoramaMeshRef.current = panoramaMesh;
    scene.add(panoramaMesh);
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
      Object.entries(hotspotRefs.current).forEach(([panoramaId, element]) => {
        if (!element || !activePanorama) return;
        const destination = panoramasByIdRef.current.get(Number(panoramaId));
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
        const distance = distanceBetweenPanoramas(activePanorama, destination);
        const scale = hotspotPerspectiveScale(distance, camera.fov);
        element.style.setProperty("--hotspot-scale", scale.toFixed(3));
        element.style.opacity = hotspotPerspectiveOpacity(distance).toFixed(3);
        element.style.zIndex = String(Math.round(18 - Math.min(distance, 32) / 4));
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
      panoramaMeshRef.current = null;
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
        panoramaMeshRef.current?.quaternion.copy(levelingQuaternion(currentPanorama));
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
    setToast(manifest?.site.source === "local-folder"
      ? "Lien de l’application copié — le dossier reste local"
      : "Lien de la visite copié");
    setMenuOpen(false);
  };

  const requestFullscreen = async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  };

  const updateVisibleRadius = (radius: number) => {
    const nextRadius = Math.max(MIN_VISIBLE_RADIUS_METERS, Math.min(MAX_VISIBLE_RADIUS_METERS, radius));
    setVisibleRadiusMeters(nextRadius);
    window.localStorage.setItem(VISIBLE_RADIUS_STORAGE_KEY, String(nextRadius));
  };

  const openFolderPicker = () => folderInputRef.current?.click();

  const importFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    const loadId = ++folderLoadIdRef.current;
    setDatasetLoading(true);
    setDatasetError("");
    setReady(false);
    setMenuOpen(false);
    setMapOpen(false);

    try {
      const loaded = await loadPanoramaFolder(files);
      if (folderLoadIdRef.current !== loadId) {
        loaded.objectUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }

      textureRef.current?.dispose();
      textureRef.current = null;
      if (materialRef.current) {
        materialRef.current.map = null;
        materialRef.current.needsUpdate = true;
      }
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = loaded.objectUrls;
      previousPanoRef.current = null;
      hotspotRefs.current = {};
      panoramasByIdRef.current = new Map(
        loaded.manifest.panoramas.map((panorama) => [panorama.id, panorama]),
      );
      setManifest(loaded.manifest);
      setCurrentId(loaded.manifest.panoramas[0]?.id ?? 0);
      setDatasetLoading(false);
      setToast(`${loaded.manifest.site.panoramaCount} panoramas chargés depuis le dossier`);
    } catch (error) {
      if (folderLoadIdRef.current !== loadId) return;
      const message = error instanceof Error ? error.message : "Ce dossier n’a pas pu être ouvert.";
      setDatasetLoading(false);
      setDatasetError(message);
      setReady(Boolean(manifest));
      setToast(message);
    }
  };

  return (
    <main className="tour-shell">
      <input
        {...DIRECTORY_PICKER_ATTRIBUTES}
        ref={folderInputRef}
        className="folder-input"
        type="file"
        multiple
        onClick={(event) => { event.currentTarget.value = ""; }}
        onChange={(event) => { void importFolder(event.currentTarget.files); }}
        aria-label="Choisir un dossier de panoramas"
      />
      <div ref={viewportRef} className="panorama-viewport" />
      <div className="viewer-vignette" aria-hidden="true" />
      <div className={`scene-transition ${transitioning ? "is-visible" : ""}`} />

      {(!ready || datasetLoading) && (
        <div className={`loading-screen ${!manifest && !datasetLoading ? "is-folder-prompt" : ""}`}>
          {!manifest && !datasetLoading ? (
            <section className="folder-start-card" aria-labelledby="folder-start-title">
              <div className="loader-mark"><span>P</span><small>360</small></div>
              <div className="folder-start-copy">
                <span>Visionneuse locale</span>
                <h1 id="folder-start-title">Chargez vos panoramas</h1>
                <p>Sélectionnez le dossier complet de votre visite pour commencer l’exploration.</p>
              </div>
              {datasetError && <p className="folder-start-error" role="alert">{datasetError}</p>}
              <button className="loading-folder-button is-primary" onClick={openFolderPicker}>
                Choisir un dossier
              </button>
              <small className="folder-start-note">
                Le fichier de poses est détecté automatiquement. Vos images restent sur cet appareil.
              </small>
            </section>
          ) : (
            <>
              <div className="loader-mark"><span>P</span><small>360</small></div>
              <div className="loading-line"><span /></div>
              <p>{datasetLoading
                ? `Préparation de ${manifest?.site.name ?? "la visite"}…`
                : `Chargement du premier panorama de ${manifest?.site.name ?? "la visite"}…`}</p>
            </>
          )}
        </div>
      )}

      <header className="topbar minimal-topbar">
        <button className="icon-button menu-button" onClick={() => setMenuOpen(true)} aria-label="Ouvrir le menu">
          <span className="hamburger" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <div className="site-title">
          <strong>{manifest?.site.name ?? "Panorama 360"}</strong>
          <small>{currentPanorama?.area ?? "Visite immersive"}</small>
        </div>
      </header>

      {hotspotsVisible && visiblePanoramas.map((destination) => (
          <button
            key={destination.id}
            ref={(element) => { hotspotRefs.current[destination.id] = element; }}
            className="nav-hotspot"
            onClick={() => goToPanorama(destination.id)}
            aria-label={`Avancer vers le panorama ${destination.id}, à ${Math.round(distanceBetweenPanoramas(currentPanorama!, destination))} mètres`}
          >
            <span className="hotspot-disc" aria-hidden="true">
              <span className="hotspot-chevron" />
            </span>
          </button>
      ))}

      <aside className={`side-drawer compact-drawer ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="drawer-head">
          <div className="brand-lockup"><span>P</span><div><strong>Panorama 360</strong><small>Visite immersive</small></div></div>
          <button onClick={() => setMenuOpen(false)} aria-label="Fermer le menu">×</button>
        </div>
        <div className="drawer-place">
          <span className="place-dot" />
          <div><small>Dossier actuel</small><strong>{manifest?.site.sourceFolder ?? manifest?.site.name ?? "Visite intégrée"}</strong></div>
        </div>
        <div className="drawer-setting">
          <div className="drawer-setting-head">
            <div><small>Navigation</small><strong>Rayon d’affichage</strong></div>
            <output htmlFor="visible-radius-meters" aria-live="polite">{visibleRadiusMeters} m</output>
          </div>
          <input
            id="visible-radius-meters"
            type="range"
            min={MIN_VISIBLE_RADIUS_METERS}
            max={MAX_VISIBLE_RADIUS_METERS}
            step="1"
            value={visibleRadiusMeters}
            onChange={(event) => updateVisibleRadius(Number(event.target.value))}
            aria-label="Rayon d’affichage des panoramas en mètres"
          />
          <div className="drawer-setting-scale" aria-hidden="true"><span>2 m</span><span>30 m</span></div>
        </div>
        <nav>
          <button onClick={openFolderPicker}><span>⌂</span><div><strong>Ouvrir un dossier</strong><small>Images 360° avec ou sans fichier de poses</small></div></button>
          <button onClick={() => { setMapOpen(true); setMenuOpen(false); }}><span>▦</span><div><strong>Plan du parcours</strong><small>{manifest?.site.panoramaCount ?? 0} panoramas</small></div></button>
          <button onClick={() => { setHotspotsVisible((visible) => !visible); setMenuOpen(false); }}><span>◉</span><div><strong>Hotspots</strong><small>{hotspotsVisible ? "Masquer les flèches" : "Afficher les flèches"}</small></div></button>
          <button onClick={() => { resetView(); setMenuOpen(false); }}><span>⌖</span><div><strong>Recentrer la vue</strong><small>Regarder vers le prochain point</small></div></button>
          <button onClick={copyLink}><span>↗</span><div><strong>Partager</strong><small>Copier le lien de la visite</small></div></button>
          <button onClick={requestFullscreen}><span>⛶</span><div><strong>Plein écran</strong><small>Masquer le navigateur</small></div></button>
        </nav>
        <p className="drawer-folder-note">Le dossier est lu uniquement sur cet appareil. Aucune image n’est envoyée.</p>
      </aside>
      {menuOpen && <button className="drawer-scrim" onClick={() => setMenuOpen(false)} aria-label="Fermer le menu" />}

      <section className="location-card simple-location">
        <span className="location-index">{String(currentId).padStart(2, "0")}</span>
        <div><strong>{currentPanorama?.area ?? "Chargement"}</strong><small>{manifest?.site.captured ?? "Date inconnue"}</small></div>
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
            <div><small>Parcours complet · 3D</small><strong>{manifest.site.name}</strong></div>
            <button onClick={() => setMapOpen(false)} aria-label="Fermer le plan">×</button>
          </div>
          <MapScene panoramas={manifest.panoramas} currentId={currentId} onSelect={goToPanorama} />
          <div className="map-panel-foot"><span><i className="legend-current" />Position actuelle</span><span><i />Panorama</span><span className="map-nav-legend">{new Set(manifest.panoramas.map((panorama) => panorama.floor)).size} niveau(x) navigable(s)</span></div>
        </section>
      )}

      <div className="interaction-hint"><span className="mouse-shape" />Glisser pour regarder · cliquer sur une flèche pour avancer</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
