// mobile/lib/device-id.ts
// Generates and persists a unique device ID for this app install.
// Used by the Interactive Override flow to detect concurrent logins:
//   - On login, the device ID is written to profiles.active_device_id
//   - A Realtime listener watches for changes; if another device overrides,
//     the old device is booted out.

import AsyncStorage from "@react-native-async-storage/async-storage";

const DEVICE_ID_KEY = "@braille_dots_device_id";

/**
 * Generate a random UUID-like string without external dependencies.
 * Uses Math.random — sufficient for device disambiguation (not crypto).
 */
function generateDeviceId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get or create a persistent device ID for this install.
 * Returns the same ID across app restarts until `resetDeviceId()` is called.
 */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Generate a brand-new device ID and persist it.
 * Called when the user explicitly overrides another device's session.
 */
export async function resetDeviceId(): Promise<string> {
  const id = generateDeviceId();
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}
