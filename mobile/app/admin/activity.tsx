// mobile/app/admin/activity.tsx
// Admin → one activity. The screen is shared with teachers: components/activities.

import { ActivityEditorScreen } from "../../components/activities/ActivityEditorScreen";

export default function AdminActivity() {
  return <ActivityEditorScreen area="admin" />;
}
