import { PassesBrowser } from "../ui/PassesBrowser.tsx";
import { PageHeader } from "../ui/parts.tsx";

export function Passes() {
  return (
    <>
      <PageHeader title="Passes" description="Every run of an agent, newest first. Click a pass to see its prompt and answer." />
      <PassesBrowser />
    </>
  );
}
