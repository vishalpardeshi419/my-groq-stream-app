import Link from "next/link";

export default function EmailVerifiedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <section className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-7 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold">Email verified</h1>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          Your email address has been verified. Sign in to continue.
        </p>
        <Link href="/login" className="mt-5 inline-block text-sm text-blue-600 hover:underline">
          Return to sign in
        </Link>
      </section>
    </main>
  );
}
