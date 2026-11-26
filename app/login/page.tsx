import { AuthForm } from "@/components/auth-form";
import { isGoogleSignInConfigured } from "@/lib/auth";

export default function LoginPage() {
  return <AuthForm mode="login" googleEnabled={isGoogleSignInConfigured} />;
}
