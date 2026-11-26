import "server-only";

import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { getDatabasePool } from "@/lib/database";
import { sendAuthEmail } from "@/lib/auth-email";
import { hashPassword, verifyPassword } from "@/lib/password";

const isProduction = process.env.NODE_ENV === "production";
const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  "development-only-auth-secret-change-before-deploying";
const authUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

export const auth = betterAuth({
  appName: "Groq Streaming Chat",
  baseURL: authUrl,
  secret: authSecret,
  database: getDatabasePool(),
  trustedOrigins: [authUrl],
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : {},
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: [],
      requireLocalEmailVerified: true,
      allowDifferentEmails: false,
      updateUserInfoOnLink: false,
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/send-verification-email": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
    },
  },
  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  plugins: [
    twoFactor({
      issuer: "Groq Streaming Chat",
      allowPasswordless: true,
      accountLockout: {
        enabled: true,
        maxFailedAttempts: 5,
        durationSeconds: 15 * 60,
      },
      backupCodeOptions: {
        amount: 10,
        length: 12,
        storeBackupCodes: "encrypted",
      },
    }),
  ],
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email,
        subject: "Verify your Groq Streaming Chat email",
        url,
        action: "Verify your email address to activate your account.",
      });
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail({
        to: user.email,
        subject: "Reset your Groq Streaming Chat password",
        url,
        action: "Use this single-use link to reset your password.",
      });
    },
    password: {
      hash: hashPassword,
      verify: ({ hash, password }) => verifyPassword(hash, password),
    },
  },
});

export const isGoogleSignInConfigured = googleConfigured;

export function assertAuthEnvironment() {
  if (isProduction && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured in production.");
  }
  if (isProduction && !process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET must be configured in production.");
  }
  if (isProduction && !process.env.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL must be configured in production.");
  }
}
