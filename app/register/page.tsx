import { AuthForm } from "@/components/auth-form";
import { isGoogleSignInConfigured } from "@/lib/auth";

export default function RegisterPage() {
  return <AuthForm mode="register" googleEnabled={isGoogleSignInConfigured} />;
}
