import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DocumentWorkspace } from "@/components/document-workspace";
import { auth } from "@/lib/auth";

export default function DocumentsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-10">
          <p role="status">Loading your documents…</p>
        </main>
      }
    >
      <DocumentsContent />
    </Suspense>
  );
}

async function DocumentsContent() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl space-y-6 px-4 py-10">
      <Link href="/ui/root" className="text-sm text-blue-600 hover:underline">
        Back to chat
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Your documents</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Upload text-based files, then inspect the closest matching chunks for a
          query. Only your account can access these documents.
        </p>
      </header>
      <DocumentWorkspace />
    </main>
  );
}
