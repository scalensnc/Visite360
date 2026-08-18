import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { createRoot } from "react-dom/client";
import { loadPanoramaFolder, type Manifest } from "../app/panorama-folder";
import "./style.css";

type RuntimeConfig = {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  maxFilesPerVisit: number;
  maxFileBytes: number;
};

type Visit = {
  id: string;
  title: string;
  slug: string;
  shareId: string;
  status: "draft" | "uploading" | "published";
  panoramaCount: number;
  createdAt: string;
  publishedAt?: string;
  sharePath?: string;
};

type UploadTarget = {
  id: string;
  index: number;
  name: string;
  url: string;
  contentType: string;
};

type AuthMode = "signin" | "signup" | "confirm";

const SESSION_KEY = "panorama360.studio.session";
const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const DIRECTORY_PICKER_ATTRIBUTES = {
  webkitdirectory: "",
} as unknown as InputHTMLAttributes<HTMLInputElement>;
const demoVisits: Visit[] = [
  {
    id: "demo-1",
    title: "Résidence du Parc",
    slug: "residence-du-parc",
    shareId: "a18f20c48b31d88a",
    status: "published",
    panoramaCount: 24,
    createdAt: new Date(Date.now() - 86_400_000 * 4).toISOString(),
    publishedAt: new Date(Date.now() - 86_400_000 * 3).toISOString(),
    sharePath: "/v/a18f20c48b31d88a/",
  },
  {
    id: "demo-2",
    title: "Atelier de Sainte-Croix",
    slug: "atelier-sainte-croix",
    shareId: "b739cd901c775bd2",
    status: "draft",
    panoramaCount: 100,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-CH", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} Mo`;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
  const cognitoMessages: Record<string, string> = {
    UsernameExistsException: "Un compte existe déjà avec cette adresse.",
    CodeMismatchException: "Le code de confirmation n’est pas correct.",
    NotAuthorizedException: "Adresse ou mot de passe incorrect.",
    InvalidPasswordException: "Le mot de passe ne respecte pas les critères indiqués.",
    UserNotConfirmedException: "Confirmez votre adresse avant de vous connecter.",
  };
  return cognitoMessages[message] ?? message;
}

async function loadConfig(): Promise<RuntimeConfig> {
  if (isLocalPreview) {
    return {
      region: "eu-central-2",
      userPoolId: "local-preview",
      userPoolClientId: "local-preview",
      maxFilesPerVisit: 100,
      maxFileBytes: 100 * 1024 * 1024,
    };
  }
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("La configuration du studio est indisponible.");
  return response.json() as Promise<RuntimeConfig>;
}

async function cognitoCall<T>(config: RuntimeConfig, operation: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as T & { __type?: string; message?: string };
  if (!response.ok) throw new Error(body.__type?.split("#").at(-1) ?? body.message ?? "Cognito a refusé la demande.");
  return body;
}

function uploadFile(target: UploadTarget, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", target.url);
    request.setRequestHeader("content-type", target.contentType);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`L’import de ${file.name} a échoué.`));
    });
    request.addEventListener("error", () => reject(new Error(`L’import de ${file.name} a été interrompu.`)));
    request.send(file);
  });
}

async function validatePanorama(file: File, maxBytes: number) {
  if (file.size > maxBytes) throw new Error(`${file.name} dépasse ${formatBytes(maxBytes)}.`);
  const bitmap = await createImageBitmap(file);
  const ratio = bitmap.width / Math.max(bitmap.height, 1);
  bitmap.close();
  if (ratio < 1.75 || ratio > 2.25) {
    throw new Error(`${file.name} n’est pas un panorama équirectangulaire proche du ratio 2:1.`);
  }
}

function AuthPanel({ config, onAuthenticated }: { config: RuntimeConfig; onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (mode === "signup") {
        await cognitoCall(config, "SignUp", {
          ClientId: config.userPoolClientId,
          Username: email,
          Password: password,
          UserAttributes: [{ Name: "email", Value: email }],
        });
        setMode("confirm");
        setMessage("Un code vient d’être envoyé à votre adresse.");
      } else if (mode === "confirm") {
        await cognitoCall(config, "ConfirmSignUp", {
          ClientId: config.userPoolClientId,
          Username: email,
          ConfirmationCode: code,
        });
        setMode("signin");
        setMessage("Adresse confirmée. Vous pouvez vous connecter.");
      } else {
        const result = await cognitoCall<{
          AuthenticationResult?: { AccessToken?: string };
        }>(config, "InitiateAuth", {
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: config.userPoolClientId,
          AuthParameters: { USERNAME: email, PASSWORD: password },
        });
        const token = result.AuthenticationResult?.AccessToken;
        if (!token) throw new Error("La connexion n’a pas retourné de session.");
        onAuthenticated(token);
      }
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-story">
        <div className="brand"><span>P</span><strong>Panorama Studio</strong></div>
        <div className="auth-copy">
          <p className="eyebrow">VISITES 360° · HÉBERGEMENT SUISSE</p>
          <h1>Une visite prête à partager, sans parcours technique.</h1>
          <p>Importez vos panoramas, publiez la visite et transmettez un seul lien à votre client.</p>
        </div>
        <div className="auth-proof">
          <span>100 panoramas par visite</span>
          <span>Lien HTTPS instantané</span>
          <span>Stockage AWS privé</span>
        </div>
      </section>
      <section className="auth-card-wrap">
        <form className="auth-card" onSubmit={submit}>
          <p className="eyebrow">ESPACE CRÉATEUR</p>
          <h2>{mode === "signup" ? "Créer votre compte" : mode === "confirm" ? "Confirmer votre adresse" : "Content de vous revoir"}</h2>
          <p className="auth-intro">
            {mode === "confirm" ? "Saisissez le code à six chiffres reçu par e-mail." : "Accédez à vos visites et suivez leur publication."}
          </p>
          <label>
            Adresse e-mail
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </label>
          {mode !== "confirm" && (
            <label>
              Mot de passe
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={10} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
              {mode === "signup" && <small>10 caractères, avec majuscule, minuscule et chiffre.</small>}
            </label>
          )}
          {mode === "confirm" && (
            <label>
              Code de confirmation
              <input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} required maxLength={6} autoComplete="one-time-code" />
            </label>
          )}
          {message && <p className="form-message" role="status">{message}</p>}
          <button className="primary-button" disabled={busy}>{busy ? "Un instant…" : mode === "signup" ? "Créer le compte" : mode === "confirm" ? "Confirmer" : "Se connecter"}</button>
          <button type="button" className="text-button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setMessage(""); }}>
            {mode === "signup" ? "J’ai déjà un compte" : "Créer un nouveau compte"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Studio({ config, token, onSignOut }: { config: RuntimeConfig; token: string; onSignOut: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [visits, setVisits] = useState<Visit[]>(isLocalPreview ? demoVisits : []);
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [folderManifest, setFolderManifest] = useState<Manifest | null>(null);
  const [preparingFolder, setPreparingFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");

  const publishedCount = visits.filter((visit) => visit.status === "published").length;
  const panoramaCount = visits.reduce((total, visit) => total + visit.panoramaCount, 0);
  const selectedSize = useMemo(() => files.reduce((total, file) => total + file.size, 0), [files]);

  async function api<T>(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers },
    });
    const body = await response.json() as T & { message?: string };
    if (!response.ok) throw new Error(body.message ?? "L’opération a échoué.");
    return body;
  }

  useEffect(() => {
    if (isLocalPreview) return;
    fetch("/api/visits", {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        const body = await response.json() as { visits?: Visit[]; message?: string };
        if (!response.ok) throw new Error(body.message ?? "Impossible de charger les visites.");
        return body.visits ?? [];
      })
      .then(setVisits)
      .catch((error) => setNotice(friendlyError(error)));
  }, [token]);

  async function selectPanoramaFolder(selectedFiles: File[]) {
    if (!selectedFiles.length) return;
    setPreparingFolder(true);
    setNotice("Analyse du dossier et du fichier de poses…");
    try {
      const loaded = await loadPanoramaFolder(selectedFiles);
      loaded.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      if (loaded.panoramaFiles.length > config.maxFilesPerVisit) {
        throw new Error(`Ce dossier contient ${loaded.panoramaFiles.length} panoramas. La limite est de ${config.maxFilesPerVisit}.`);
      }
      setFiles(loaded.panoramaFiles);
      setFolderManifest({
        ...loaded.manifest,
        panoramas: loaded.manifest.panoramas.map((panorama) => ({ ...panorama, image: "" })),
      });
      if (!title.trim()) setTitle(loaded.manifest.site.name);
      setNotice(loaded.manifest.site.poseSource
        ? `${loaded.panoramaFiles.length} panoramas et le fichier ${loaded.manifest.site.poseSource} ont été reconnus.`
        : `${loaded.panoramaFiles.length} panoramas reconnus. Aucun fichier de poses n’a été trouvé : le parcours sera séquentiel.`);
    } catch (error) {
      setFiles([]);
      setFolderManifest(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice(friendlyError(error));
    } finally {
      setPreparingFolder(false);
    }
  }

  async function createAndPublish(event: FormEvent) {
    event.preventDefault();
    if (!files.length) {
      fileInputRef.current?.click();
      return;
    }
    setBusy(true);
    setProgress(0);
    setNotice("Vérification des panoramas…");
    try {
      for (const file of files) await validatePanorama(file, config.maxFileBytes);
      if (isLocalPreview) {
        for (let value = 5; value <= 100; value += 5) {
          await new Promise((resolve) => window.setTimeout(resolve, 35));
          setProgress(value);
        }
        const created: Visit = {
          id: crypto.randomUUID(),
          title: title.trim(),
          slug: title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-"),
          shareId: crypto.randomUUID().replace(/-/g, "").slice(0, 18),
          status: "published",
          panoramaCount: files.length,
          createdAt: new Date().toISOString(),
          publishedAt: new Date().toISOString(),
          sharePath: "/v/demo/",
        };
        setVisits((current) => [created, ...current]);
        setNotice("Démo terminée : la visite serait maintenant accessible par son lien client.");
      } else {
        const created = await api<{ visit: Visit }>("/api/visits", {
          method: "POST",
          body: JSON.stringify({ title }),
        });
        const prepared = await api<{ uploads: UploadTarget[] }>(`/api/visits/${created.visit.id}/uploads`, {
          method: "POST",
          body: JSON.stringify({
            files: files.map((file, index) => {
              const panorama = folderManifest?.panoramas[index];
              return {
                name: file.name,
                size: file.size,
                type: file.type,
                pose: panorama ? {
                  id: panorama.id,
                  label: panorama.label,
                  area: panorama.area,
                  floor: panorama.floor,
                  position: panorama.position,
                  orientation: panorama.orientation,
                  neighbors: panorama.neighbors,
                  timestamp: panorama.timestamp,
                } : undefined,
              };
            }),
            tour: folderManifest ? {
              sourceFolder: folderManifest.site.sourceFolder,
              captured: folderManifest.site.captured,
              poseSource: folderManifest.site.poseSource,
              poseConvention: folderManifest.site.poseConvention,
              bounds: folderManifest.site.bounds,
            } : undefined,
          }),
        });
        let completed = 0;
        for (let index = 0; index < prepared.uploads.length; index += 3) {
          const group = prepared.uploads.slice(index, index + 3);
          await Promise.all(group.map((target) => uploadFile(target, files[target.index], (fileProgress) => {
            setProgress(Math.round(((completed + fileProgress / 100) / files.length) * 100));
          })));
          completed += group.length;
          setProgress(Math.round((completed / files.length) * 100));
        }
        const published = await api<{ visit: Visit }>(`/api/visits/${created.visit.id}/publish`, { method: "POST" });
        setVisits((current) => [published.visit, ...current]);
        setNotice("La visite est publiée. Son lien peut maintenant être transmis au client.");
      }
      setTitle("");
      setFiles([]);
      setFolderManifest(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(visit: Visit) {
    if (!visit.sharePath) return;
    const link = new URL(visit.sharePath, window.location.origin).toString();
    await navigator.clipboard.writeText(link);
    setNotice("Lien client copié.");
  }

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <div className="brand"><span>P</span><strong>Panorama Studio</strong></div>
        <nav aria-label="Navigation principale">
          <button className="is-active"><span>▦</span>Mes visites</button>
          <button><span>＋</span>Nouvelle visite</button>
          <button><span>◉</span>Stockage</button>
        </nav>
        <div className="sidebar-foot">
          <div className="region-dot"><i /> AWS Zurich</div>
          {isLocalPreview && <small>Mode aperçu local</small>}
          <button onClick={onSignOut}>Se déconnecter</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-head">
          <div>
            <p className="eyebrow">ESPACE CRÉATEUR</p>
            <h1>Vos visites 360°</h1>
            <p>Créez une visite et partagez-la avec votre client en quelques minutes.</p>
          </div>
          <button className="primary-button" onClick={() => document.getElementById("new-visit")?.scrollIntoView({ behavior: "smooth" })}>＋ Nouvelle visite</button>
        </header>

        <section className="metrics" aria-label="Résumé">
          <article><span>Visites publiées</span><strong>{publishedCount}</strong><small>liens client actifs</small></article>
          <article><span>Panoramas stockés</span><strong>{panoramaCount}</strong><small>toutes visites confondues</small></article>
          <article><span>Stockage estimé</span><strong>{Math.max(0.1, panoramaCount * 0.006).toFixed(1)} Go</strong><small>optimisation incluse</small></article>
        </section>

        <section className="visit-section">
          <div className="section-head"><div><p className="eyebrow">BIBLIOTHÈQUE</p><h2>Visites récentes</h2></div><span>{visits.length} visite{visits.length > 1 ? "s" : ""}</span></div>
          <div className="visit-table">
            <div className="table-row table-labels"><span>Visite</span><span>Panoramas</span><span>État</span><span>Publication</span><span /></div>
            {visits.map((visit) => (
              <article className="table-row" key={visit.id}>
                <div className="visit-name"><i>{visit.title.slice(0, 1).toLocaleUpperCase()}</i><span><strong>{visit.title}</strong><small>{visit.slug}</small></span></div>
                <span>{visit.panoramaCount}</span>
                <span><b className={`status status-${visit.status}`}>{visit.status === "published" ? "Publiée" : visit.status === "uploading" ? "Import" : "Brouillon"}</b></span>
                <span>{formatDate(visit.publishedAt ?? visit.createdAt)}</span>
                <div className="row-actions">
                  {visit.sharePath && <button onClick={() => copyLink(visit)}>Copier le lien</button>}
                  {visit.sharePath && <a href={visit.sharePath} target="_blank" rel="noreferrer" aria-label={`Ouvrir ${visit.title}`}>↗</a>}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="new-visit" className="create-card">
          <div className="create-copy">
            <p className="eyebrow">NOUVELLE VISITE</p>
            <h2>Importez le dossier de panoramas</h2>
            <p>Sélectionnez le dossier complet contenant jusqu’à {config.maxFilesPerVisit} images JPEG, PNG ou WebP ainsi que le fichier de poses CSV. Chaque panorama doit être équirectangulaire, au format 2:1.</p>
            <ul><li>Positions, orientations et niveaux lus automatiquement</li><li>Connexions entre panoramas calculées depuis les poses</li><li>Images envoyées directement dans votre stockage privé</li></ul>
          </div>
          <form className="create-form" onSubmit={createAndPublish}>
            <label>
              Nom de la visite
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex. Résidence du Parc" required minLength={2} maxLength={100} />
            </label>
            <input ref={fileInputRef} className="file-input" type="file" multiple {...DIRECTORY_PICKER_ATTRIBUTES} onChange={(event) => void selectPanoramaFolder(Array.from(event.target.files ?? []))} />
            <button type="button" className="drop-zone" disabled={busy || preparingFolder} onClick={() => fileInputRef.current?.click()}>
              <span>＋</span>
              <strong>{preparingFolder ? "Analyse du dossier…" : files.length ? `${files.length} panorama${files.length > 1 ? "s" : ""} sélectionné${files.length > 1 ? "s" : ""}` : "Sélectionner le dossier complet"}</strong>
              <small>{files.length ? `${formatBytes(selectedSize)} · ${folderManifest?.site.poseSource ? `poses : ${folderManifest.site.poseSource}` : "sans fichier de poses"}` : "images panoramiques + fichier de poses CSV"}</small>
            </button>
            {busy && <div className="progress"><span style={{ width: `${progress}%` }} /><small>{progress}%</small></div>}
            <button className="primary-button publish-button" disabled={busy || preparingFolder}>{busy ? "Préparation de la visite…" : "Importer et publier"}</button>
          </form>
        </section>

        {notice && <div className="notice" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Fermer">×</button></div>}
      </main>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [token, setToken] = useState(() => isLocalPreview ? "local-preview" : sessionStorage.getItem(SESSION_KEY) ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    loadConfig().then(setConfig).catch((loadError) => setError(friendlyError(loadError)));
  }, []);

  if (error) return <main className="fatal-error"><strong>Studio indisponible</strong><p>{error}</p></main>;
  if (!config) return <main className="loading-screen"><div className="brand"><span>P</span><strong>Panorama Studio</strong></div><p>Préparation du studio…</p></main>;
  if (!token) {
    return <AuthPanel config={config} onAuthenticated={(accessToken) => { sessionStorage.setItem(SESSION_KEY, accessToken); setToken(accessToken); }} />;
  }
  return <Studio config={config} token={token} onSignOut={() => { sessionStorage.removeItem(SESSION_KEY); setToken(""); }} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Le conteneur principal est introuvable.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
