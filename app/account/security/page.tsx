import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SecuritySettings } from "@/components/security-settings";
import { auth } from "@/lib/auth";

export default function AccountSecurityPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-10">
          <p role="status">Loading account security…</p>
        </main>
      }
    >
      <AccountSecurityContent />
    </Suspense>
  );
}

async function AccountSecurityContent() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl space-y-6 px-4 py-10">
      <Link href="/ui/root" className="text-sm text-blue-600 hover:underline">
        Back to chat
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Account security</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in as {session.user.email}
        </p>
      </header>
      <SecuritySettings />
    </main>
  );
}
