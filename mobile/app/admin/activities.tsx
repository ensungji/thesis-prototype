// mobile/app/admin/activities.tsx
// Admin → Activities. The screen is shared with teachers: components/activities.

import { ActivityListScreen } from "../../components/activities/ActivityListScreen";

export default function AdminActivities() {
  return <ActivityListScreen area="admin" />;
}
