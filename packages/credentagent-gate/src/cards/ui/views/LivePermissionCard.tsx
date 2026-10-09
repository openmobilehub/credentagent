// The permission card with its live status: it starts the page's follow of the signature (once per
// grant — a redraw never starts another) and re-renders from the watch, which lives outside React.
import { useEffect, useSyncExternalStore } from "react";
import type { PermissionCardData } from "../../contract";
import type { SignatureWatch } from "../signature-watch";
import { PermissionCard } from "./PermissionCard";

export function LivePermissionCard({ data, qr, watch, open }: { data: PermissionCardData; qr: unknown; watch: SignatureWatch; open: (url: string) => Promise<void> }) {
  useEffect(() => watch.follow(data.grantId, data.store.name), [watch, data.grantId, data.store.name]);
  const read = () => watch.state(data.grantId);
  const state = useSyncExternalStore(watch.subscribe, read, read);
  return <PermissionCard data={data} qr={qr} state={state} open={open} />;
}
