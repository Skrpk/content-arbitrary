import { WebQueue } from './web-queue';

/**
 * The review queue on the website: the same queue as the Mini App's, with
 * room to read it — picture beside text — and keys to work through it.
 */
export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const query = await searchParams;
  const id = (value: string | undefined) => {
    const wanted = Number(value);
    return Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null;
  };
  return <WebQueue initialWorkspaceId={id(query.workspace)} initialPostId={id(query.post)} />;
}
