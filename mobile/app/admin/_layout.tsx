// mobile/app/admin/_layout.tsx
// Stack navigator for the admin area + admin auth guard.

import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";

export default function AdminLayout() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace("/"); return; }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", session.user.id)
        .single();
      if (profile?.role !== "admin") router.replace("/");
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) router.replace("/");
      }
    );
    return () => subscription.unsubscribe();
  }, [router]);

  return <Stack screenOptions={{ headerShown: false }} />;
}