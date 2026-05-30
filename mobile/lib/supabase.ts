// mobile/lib/supabase.ts
// Supabase client — one shared instance imported everywhere.
//
// Requires these packages (run from mobile/):
//   npx expo install @supabase/supabase-js react-native-url-polyfill @react-native-async-storage/async-storage
//
// Requires mobile/.env (never commit this file):
//   EXPO_PUBLIC_SUPABASE_URL=https://49fcddfc-0c7a-43e7-9775-ab2fa6ad8a3b.supabase.co
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-from-the-supabase-dashboard

import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,   // persist the session across app restarts
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false, // required for React Native (no browser URL)
  },
});