// mobile/app/admin/_layout.tsx
// Stack navigator for the admin area + admin auth guard.
// lib/route-for-session decides: a teacher goes to the teacher screens, a
// deactivated user is signed out (→ welcome), and if the profile can't load
// (offline) the admin stays here instead of being bounced around.

import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { ADMIN_HOME, routeForSession } from "../../lib/route-for-session";

export default function AdminLayout() {
  const router = useRouter();

  useEffect(() => {
    routeForSession().then(({ route, reason }) => {
      if (reason === "no-session" || reason === "inactive") router.replace("/");
      else if (route && route !== ADMIN_HOME) router.replace(route as any);
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