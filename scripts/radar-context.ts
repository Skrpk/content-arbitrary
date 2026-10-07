/**
 * Print the exact context Shadow Radar would build for a post — instructions,
 * editorial profile, publication-history profile, past decisions, similar
 * past publications, the post — without asking Radar's model. For inspecting
 * and debugging the prompt.
 *
 *   npm run radar:context -- --workspace 2 [--post <processed post id>] [--prompt radar-v1]
 *
 * Without --post, the workspace's most recent post; without --prompt, the
 * newest prompt, whose similar-publication search embeds the post once
 * (a fraction of a cent, stored and reused). The context is built as of the
 * post's arrival, as a backfill would: only decisions made before it, a
 * history profile only if it was made from publications before it, and only
 * publications from before it in the search.
 */
import 'dotenv/config';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { processedPosts, workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { getEnv } from '../src/lib/env';
import { createEmbeddingProvider } from '../src/lib/history/embeddings/provider';
import { retrieveSimilarPublications } from '../src/lib/history/embeddings/retrieval';
import { loadRadarPublicationProfile } from '../src/lib/history/profile/repository';
import {
  buildSystemPrompt,
  buildUserContent,
  describeStoredMedia,
  isRadarPromptVersion,
  RADAR_EXAMPLES_PER_CLASS,
  RADAR_PROMPT_APPROVED,
  usesApprovedRetrieval,
  usesHistoryRetrieval,
} from '../src/lib/radar/prompt';
import { loadRadarHistory } from '../src/lib/radar/repository';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const workspaceId = Number(argument('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('Pass the workspace: --workspace <id>');
  }
  const promptVersion = argument('prompt') ?? RADAR_PROMPT_APPROVED;
  if (!isRadarPromptVersion(promptVersion)) throw new Error(`Unknown prompt version "${promptVersion}"`);
  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`No workspace ${workspaceId}`);
  if (!workspace.editorialProfile?.trim()) throw new Error(`Workspace ${workspaceId} has no editorial_profile`);

  const postId = argument('post');
  const [post] = await db
    .select()
    .from(processedPosts)
    .where(
      and(
        eq(processedPosts.workspaceId, workspaceId),
        isNotNull(processedPosts.sourceText),
        postId ? eq(processedPosts.id, Number(postId)) : undefined,
      ),
    )
    .orderBy(desc(processedPosts.createdAt))
    .limit(1);
  if (!post) throw new Error(postId ? `No post ${postId} with text in workspace ${workspaceId}` : 'No posts yet');

  const history = await loadRadarHistory(db, {
    workspaceId,
    before: post.createdAt,
    excludePostId: post.id,
    perClass: RADAR_EXAMPLES_PER_CLASS,
  });
  const publication = await loadRadarPublicationProfile(db, { workspaceId, arrivedAt: post.createdAt });
  const retrieval = usesHistoryRetrieval(promptVersion)
    ? await retrieveSimilarPublications({
        db,
        embeddings: createEmbeddingProvider(getEnv()),
        workspaceId,
        processedPostId: post.id,
        candidateText: post.sourceText,
        before: post.createdAt,
        includeApproved: usesApprovedRetrieval(promptVersion),
      })
    : null;

  console.log(`# Radar context · ${promptVersion} · post ${post.id} · as of ${post.createdAt.toISOString()}`);
  console.log(`# Past decisions shown: ${history.examples.length} · history profile: ${publication ? `#${publication.id}` : 'none'}`);
  if (retrieval) {
    const found = retrieval.matches.map((match) => `#${match.itemId} (${match.similarity.toFixed(3)})`).join(', ');
    console.log(
      `# Similar publications: ${retrieval.status}` +
        (retrieval.embeddingModel ? ` · ${retrieval.embeddingModel}` : '') +
        (found ? ` · ${found}` : '') +
        (retrieval.error ? ` · ${retrieval.error}` : ''),
    );
    if (retrieval.approved) {
      const approved = retrieval.approved.matches
        .map((match) => `post ${match.processedPostId} (${match.similarity.toFixed(3)})`)
        .join(', ');
      console.log(`# Similar approved posts: ${retrieval.approved.status}${approved ? ` · ${approved}` : ''}`);
    }
  }
  console.log('\n## Instructions (system)\n');
  console.log(buildSystemPrompt(workspace.editorialProfile, history.approvalRate, publication?.profile, promptVersion));
  console.log('\n## Message (user)\n');
  const content = buildUserContent(
    {
      sourceUsername: post.xAuthorUsername ?? 'unknown',
      text: post.sourceText ?? '',
      media: describeStoredMedia(post.telegramMethod, post.mediaCount),
    },
    history.examples,
    undefined,
    retrieval?.matches ?? null,
    usesApprovedRetrieval(promptVersion) ? (retrieval?.approved?.matches ?? []) : null,
  );
  for (const part of content) console.log(part.type === 'text' ? part.text : '[image]');
}

main()
  .then(() => getSql().end())
  .catch(async (error) => {
    console.error('Radar context failed:', error instanceof Error ? error.message : error);
    await getSql().end().catch(() => {});
    process.exit(1);
  });
