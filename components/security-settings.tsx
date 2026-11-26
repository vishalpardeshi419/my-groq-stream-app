"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";

export function SecuritySettings() {
  const { data: session, isPending } = authClient.useSession();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{
    totpURI: string;
    backupCodes: string[];
    verified: boolean;
  } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [twoFactorOverride, setTwoFactorOverride] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!enrollment?.totpURI) return;

    let active = true;
    QRCode.toDataURL(enrollment.totpURI, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (active) setQrCode(dataUrl);
      })
      .catch(() => {
        if (active) setError("Unable to create the authenticator QR code.");
      });

    return () => {
      active = false;
    };
  }, [enrollment?.totpURI]);

  async function enableTwoFactor() {
    setError("");
    setMessage("");
    setQrCode("");
    setIsSubmitting(true);
    try {
      const result = await authClient.twoFactor.enable({
        ...(password ? { password } : {}),
        method: "totp",
        issuer: "Groq Streaming Chat",
      });
      if (result.error) throw new Error(result.error.message);
      if (result.data.method !== "totp") {
        throw new Error("The authenticator setup could not be started.");
      }
      setEnrollment({
        totpURI: result.data.totpURI,
        backupCodes: result.data.backupCodes,
        verified: false,
      });
      setCode("");
      setPassword("");
    } catch (enableError) {
      setError(
        enableError instanceof Error
          ? enableError.message
          : "Unable to start two-factor setup.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmEnrollment() {
    setError("");
    setIsSubmitting(true);
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: code.trim(),
        trustDevice: false,
      });
      if (result.error) throw new Error(result.error.message);
      setEnrollment((current) =>
        current ? { ...current, verified: true } : current,
      );
      setRecoveryCodes(enrollment?.backupCodes ?? []);
      setTwoFactorOverride(true);
      setCode("");
    } catch (verifyError) {
      setError(
        verifyError instanceof Error
          ? verifyError.message
          : "The authenticator code was not accepted.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function regenerateRecoveryCodes() {
    setError("");
    setMessage("");
    setIsSubmitting(true);
    try {
      const result = await authClient.twoFactor.generateBackupCodes({
        ...(password ? { password } : {}),
      });
      if (result.error) throw new Error(result.error.message);
      setRecoveryCodes(result.data.backupCodes);
      setPassword("");
      setMessage("New recovery codes were created. Previous codes no longer work.");
    } catch (generateError) {
      setError(
        generateError instanceof Error
          ? generateError.message
          : "Unable to regenerate recovery codes.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function disableTwoFactor() {
    setError("");
    setMessage("");
    setIsSubmitting(true);
    try {
      const result = await authClient.twoFactor.disable({
        ...(password ? { password } : {}),
      });
      if (result.error) throw new Error(result.error.message);
      setPassword("");
      setEnrollment(null);
      setRecoveryCodes([]);
      setTwoFactorOverride(false);
      setMessage("Two-factor authentication has been disabled.");
    } catch (disableError) {
      setError(
        disableError instanceof Error
          ? disableError.message
          : "Unable to disable two-factor authentication.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isPending) {
    return <p role="status">Loading account security…</p>;
  }

  if (!session) {
    return <p role="alert">Your session has expired. Sign in again to continue.</p>;
  }

  const twoFactorEnabled =
    twoFactorOverride ?? Boolean(session.user.twoFactorEnabled);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Authenticator app</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Application TOTP is required for email/password sign-ins when enabled.
          Google sign-in uses Google’s own account security and is not an application
          second-factor challenge.
        </p>

        {!twoFactorEnabled && !enrollment && (
          <div className="mt-4 space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span>
                Password{" "}
                <span className="text-zinc-500">(required for password accounts)</span>
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                className="w-full max-w-sm rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void enableTwoFactor()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Enable two-factor authentication
            </button>
          </div>
        )}

        {enrollment && !enrollment.verified && (
          <div className="mt-5 space-y-4">
            <p className="text-sm">
              Scan this QR code locally with your authenticator app, then enter its
              current code to confirm enrollment.
            </p>
            {qrCode ? (
              <Image
                src={qrCode}
                alt="Authenticator enrollment QR code"
                width={220}
                height={220}
                unoptimized
              />
            ) : (
              <p role="status" className="text-sm text-zinc-500">
                Preparing QR code…
              </p>
            )}
            <label className="block space-y-1.5 text-sm">
              <span>Authenticator code</span>
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.currentTarget.value)}
                className="w-full max-w-sm rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono dark:border-zinc-700"
              />
            </label>
            <button
              type="button"
              disabled={isSubmitting || code.trim().length !== 6}
              onClick={() => void confirmEnrollment()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Confirm and enable
            </button>
          </div>
        )}

        {twoFactorEnabled && (
          <div className="mt-4 space-y-4">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Two-factor authentication is enabled.
            </p>
            <label className="block space-y-1.5 text-sm">
              <span>
                Password{" "}
                <span className="text-zinc-500">(required for password accounts)</span>
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                className="w-full max-w-sm rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void regenerateRecoveryCodes()}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Regenerate recovery codes
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void disableTwoFactor()}
                className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                Disable 2FA
              </button>
            </div>
          </div>
        )}

        {recoveryCodes.length > 0 && (
          <div className="mt-5 rounded-md bg-amber-50 p-4 dark:bg-amber-950/40">
            <h3 className="font-medium">Save your recovery codes now</h3>
            <p className="mt-1 text-sm">
              Each code works once. Generating new codes invalidates this set.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm">
              {recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setRecoveryCodes([])}
              className="mt-3 text-sm text-blue-700 underline dark:text-blue-300"
            >
              I have saved these codes
            </button>
          </div>
        )}
      </section>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    </div>
  );
}
