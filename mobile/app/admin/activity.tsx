// mobile/app/admin/activity.tsx
// Admin → one activity, read-only, with Hide / Unhide for a published one.
// The screen is shared with teachers: components/activities.

import { ActivityEditorScreen } from "../../components/activities/ActivityEditorScreen";

export default function AdminActivity() {
  return <ActivityEditorScreen area="admin" />;
}
