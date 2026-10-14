import { notFound } from 'next/navigation';
import { WebPostEditor } from './web-post-editor';

/** The full post editor, on the website. */
export default async function EditPage({
  params,
  searchParams,
}: {
  params: Promise<{ postId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const postId = Number((await params).postId);
  if (!Number.isSafeInteger(postId) || postId <= 0) notFound();
  const query = await searchParams;
  const workspace = Number(query.workspace);
  return (
    <WebPostEditor
      postId={postId}
      workspaceId={Number.isSafeInteger(workspace) && workspace > 0 ? workspace : null}
      from={query.from === 'scheduled' ? 'scheduled' : 'queue'}
    />
  );
}
