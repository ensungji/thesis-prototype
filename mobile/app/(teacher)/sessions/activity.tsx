// mobile/app/(teacher)/sessions/activity.tsx
// Teacher → one activity: editor for their own drafts, read-only otherwise.

import { ActivityEditorScreen } from "../../../components/activities/ActivityEditorScreen";

export default function TeacherActivity() {
  return <ActivityEditorScreen area="teacher" />;
}
