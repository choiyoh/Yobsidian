import { useCallback, useEffect, useMemo, useState } from "react";
import type { DriveLink } from "@/app/vault-config";
import { createAuth, loadGoogleSettings, type DriveAuth } from "@/core/sync/auth";
import { SyncController, type SyncStatus } from "@/core/sync/controller";
import { DriveClient } from "@/core/sync/drive-client";
import { SyncEngine } from "@/core/sync/engine";
import { IdbSyncStore } from "@/core/sync/state";
import type { VaultAdapter } from "@/core/vault";

let authPromise: Promise<DriveAuth> | null = null;
/** One sign-in session per page load, shared by the sync loop and the folder picker. */
function sharedAuth(): Promise<DriveAuth> {
  return (authPromise ??= (async () => {
    const auth = createAuth();
    await auth.ready();
    return auth;
  })());
}

const ACCOUNT_KEY = "yobsidian.google.account";

export interface DriveSync {
  /** `null` until the stored sign-in has been read. */
  auth: DriveAuth | null;
  signedIn: boolean;
  /** Is there an OAuth client id to sign in with? */
  configured: boolean;
  account: string | null;
  /** Drive API client for the folder picker; null until signed in. */
  client: DriveClient | null;
  /** `null` while the vault is not linked to a Drive folder. */
  status: SyncStatus | null;
  controller: SyncController | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Forget the sync bookkeeping for this link (the notes themselves stay). */
  forget(): Promise<void>;
  /** Re-read the saved OAuth client settings after the user edits them. */
  reloadSettings(): void;
}

/** Wires the local vault, the sign-in session and a link to a Drive folder into a running sync loop. */
export function useDriveSync(vault: VaultAdapter, link: DriveLink | null): DriveSync {
  const [auth, setAuth] = useState<DriveAuth | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [account, setAccount] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACCOUNT_KEY);
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let live = true;
    void sharedAuth().then((a) => {
      if (!live) return;
      setAuth(a);
      setSignedIn(a.isSignedIn());
    });
    return () => void (live = false);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const configured = useMemo(() => loadGoogleSettings().clientId !== "", [settingsVersion]);

  const client = useMemo(() => (auth && signedIn ? new DriveClient({ tokens: auth, fetch: auth.fetch }) : null), [auth, signedIn]);

  const folderId = link?.folderId;
  const controller = useMemo(() => {
    if (!client || !folderId) return null;
    const engine = new SyncEngine({ vault, drive: client, store: new IdbSyncStore(`${vault.id}|${folderId}`), rootId: folderId });
    return new SyncController(vault, engine);
  }, [client, vault, folderId]);

  useEffect(() => {
    if (!controller) return setStatus(null);
    setStatus(controller.getStatus());
    const off = controller.subscribe(setStatus);
    controller.start();
    return () => {
      off();
      controller.stop();
    };
  }, [controller]);

  // Browser tokens last an hour; the next click or key press (a user gesture, so the popup is allowed) renews it.
  const needsRenewal = status?.phase === "auth-needed" && auth?.kind === "web" && auth.isSignedIn();
  useEffect(() => {
    if (!needsRenewal || !auth || !controller) return;
    const off = () => {
      window.removeEventListener("pointerdown", renew, true);
      window.removeEventListener("keydown", renew, true);
    };
    const renew = () => {
      off();
      auth.signIn().then(() => controller.syncNow(), () => {});
    };
    window.addEventListener("pointerdown", renew, true);
    window.addEventListener("keydown", renew, true);
    return off;
  }, [needsRenewal, auth, controller]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.about().then(
      ({ email }) => {
        if (!live || !email) return;
        setAccount(email);
        try {
          localStorage.setItem(ACCOUNT_KEY, email);
        } catch {
          // not remembered
        }
      },
      () => {},
    );
    return () => void (live = false);
  }, [client]);

  const signIn = useCallback(async () => {
    if (!auth) return;
    await auth.signIn();
    setSignedIn(true);
    void controller?.syncNow();
  }, [auth, controller]);

  const signOut = useCallback(async () => {
    await auth?.signOut();
    setSignedIn(false);
    setAccount(null);
    try {
      localStorage.removeItem(ACCOUNT_KEY);
    } catch {
      // ignore
    }
  }, [auth]);

  const forget = useCallback(async () => {
    if (!folderId) return;
    const store = new IdbSyncStore(`${vault.id}|${folderId}`);
    await store.clear();
    await store.close();
  }, [vault, folderId]);

  return { auth, signedIn, configured, account, client, status, controller, signIn, signOut, forget, reloadSettings: () => setSettingsVersion((v) => v + 1) };
}
