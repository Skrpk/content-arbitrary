import { WebQueue } from './web-queue';

/**
 * The review queue on the website: the same queue as the Mini App's, with
 * room to read it — picture beside text — and keys to work through it.
 */
export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const wanted = Number((await searchParams).workspace);
  return <WebQueue initialWorkspaceId={Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null} />;
}
