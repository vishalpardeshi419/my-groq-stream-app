"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

type AuthFormMode =
  | "login"
  | "register"
  | "resend-verification"
  | "forgot"
  | "reset"
  | "two-factor";

const formCopy: Record<AuthFormMode, { title: string; submit: string }> = {
  login: { title: "Welcome back", submit: "Sign in" },
  register: { title: "Create your account", submit: "Create account" },
  "resend-verification": {
    title: "Resend verification email",
    submit: "Send verification link",
  },
  forgot: { title: "Reset your password", submit: "Send reset link" },
  reset: { title: "Choose a new password", submit: "Reset password" },
  "two-factor": { title: "Verify your identity", submit: "Verify code" },
};

export function AuthForm({
  mode,
  googleEnabled = false,
}: {
  mode: AuthFormMode;
  googleEnabled?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setIsSubmitting(true);

    try {
      if (mode === "login") {
        const result = await authClient.signIn.email({
          email: email.trim().toLowerCase(),
          password,
          callbackURL: "/ui/root",
        });
        if (result.error) throw new Error(result.error.message);
        if (result.data && "twoFactorRedirect" in result.data) {
          router.replace("/two-factor");
          return;
        }
        router.replace("/ui/root");
        return;
      }

      if (mode === "register") {
        const result = await authClient.signUp.email({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          callbackURL: "/email-verified",
        });
        if (result.error) throw new Error(result.error.message);
        setMessage("If registration can proceed, a verification link will be sent to that email.");
        return;
      }

      if (mode === "resend-verification") {
        const result = await authClient.sendVerificationEmail({
          email: email.trim().toLowerCase(),
          callbackURL: "/email-verified",
        });
        if (result.error) throw new Error(result.error.message);
        setMessage(
          "If the account exists and still needs verification, a new link will be sent.",
        );
        return;
      }

      if (mode === "forgot") {
        const result = await authClient.requestPasswordReset({
          email: email.trim().toLowerCase(),
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage("If an account matches that email, a password-reset link will be sent.");
        return;
      }

      if (mode === "reset") {
        if (password !== confirmation) {
          throw new Error("The passwords do not match.");
        }
        const token = new URLSearchParams(window.location.search).get("token");
        if (!token) throw new Error("This password-reset link is invalid or expired.");
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) throw new Error(result.error.message);
        setMessage("Your password has been reset. You can now sign in.");
        return;
      }

      const result = useRecoveryCode
        ? await authClient.twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice: false,
          })
        : await authClient.twoFactor.verifyTotp({
            code: code.trim(),
            trustDevice: false,
          });
      if (result.error) throw new Error(result.error.message);
      router.replace("/ui/root");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to complete this request. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function signInWithGoogle() {
    setError("");
    setIsSubmitting(true);
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/ui/root",
      });
      if (result.error) throw new Error(result.error.message);
    } catch (signInError) {
      setError(
        signInError instanceof Error
          ? signInError.message
          : "Google sign-in is unavailable. Please try again.",
      );
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10 dark:bg-zinc-950">
      <section className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Link href="/ui/root" className="text-sm text-blue-600 hover:underline">
          Groq Streaming Chat
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">{formCopy[mode].title}</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {mode === "two-factor"
            ? "Enter the code from your authenticator app or use a one-time recovery code."
            : mode === "register"
              ? "Verify your email address to activate your account."
              : mode === "forgot"
                ? "We’ll send a link if an account matches the address."
                    : mode === "resend-verification"
                      ? "Request another link to verify your email address."
                : mode === "reset"
                  ? "Use a password with at least 12 characters."
                  : "Sign in to continue to your chats."}
        </p>

        {(mode === "login" || mode === "register") && (
          <>
            <button
              type="button"
              disabled={!googleEnabled || isSubmitting}
              onClick={() => void signInWithGoogle()}
              className="mt-6 w-full rounded-md border border-zinc-300 px-4 py-2.5 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Continue with Google
            </button>
            {!googleEnabled && (
              <p className="mt-2 text-xs text-zinc-500">
                Google sign-in requires OAuth credentials in the server environment.
              </p>
            )}
            <div className="my-5 flex items-center gap-3 text-xs text-zinc-500">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
              or use email
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
            </div>
          </>
        )}

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {mode === "register" && (
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <input
                autoComplete="name"
                maxLength={100}
                required
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
          )}

          {(mode === "login" ||
            mode === "register" ||
            mode === "resend-verification" ||
            mode === "forgot") && (
            <label className="block space-y-1.5 text-sm">
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
          )}

          {(mode === "login" || mode === "register" || mode === "reset") && (
            <label className="block space-y-1.5 text-sm">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? undefined : 12}
                maxLength={128}
                required
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
          )}

          {mode === "reset" && (
            <label className="block space-y-1.5 text-sm">
              <span>Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
              />
            </label>
          )}

          {mode === "two-factor" && (
            <>
              <label className="block space-y-1.5 text-sm">
                <span>{useRecoveryCode ? "Recovery code" : "Authenticator code"}</span>
                <input
                  autoComplete="one-time-code"
                  inputMode={useRecoveryCode ? "text" : "numeric"}
                  maxLength={32}
                  required
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono dark:border-zinc-700"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setUseRecoveryCode((current) => !current);
                  setCode("");
                }}
                className="text-sm text-blue-600 hover:underline"
              >
                {useRecoveryCode ? "Use an authenticator code" : "Use a recovery code"}
              </button>
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? "Please wait…" : formCopy[mode].submit}
          </button>
        </form>

        <nav className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {mode === "login" && (
            <>
              <Link href="/register" className="text-blue-600 hover:underline">
                Create account
              </Link>
              <Link href="/forgot-password" className="text-blue-600 hover:underline">
                Forgot password?
              </Link>
              <Link
                href="/resend-verification"
                className="text-blue-600 hover:underline"
              >
                Resend verification email
              </Link>
            </>
          )}
          {mode === "register" && (
            <>
              <Link href="/login" className="text-blue-600 hover:underline">
                Already have an account? Sign in
              </Link>
              <Link
                href="/resend-verification"
                className="text-blue-600 hover:underline"
              >
                Need another verification link?
              </Link>
            </>
          )}
          {(mode === "forgot" ||
            mode === "reset" ||
            mode === "two-factor" ||
            mode === "resend-verification") && (
            <Link href="/login" className="text-blue-600 hover:underline">
              Back to sign in
            </Link>
          )}
        </nav>
      </section>
    </main>
  );
}
