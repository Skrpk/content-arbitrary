'use client';

import { useEffect, useState } from 'react';
import { MiniAppFrame } from '@/components/mini-app-frame';
import type { PanelTools } from '@/components/panel-tools';
import { PostEditor } from '@/components/rich-editor/post-editor';
import { finishMiniApp, offerBackToQueue, postIdFromLocation, queueReturnUrl, theme } from '@/lib/telegram/webapp-client';

/**
 * The Edit Mini App, opened from the Edit button under a post awaiting review
 * or from the review queue. The editor, with its AI assistant, is the
 * website's too (src/components/rich-editor/post-editor.tsx); done goes back
 * to the queue when it was opened from there, and closes the Mini App when
 * it was opened from the chat.
 */
export default function ReviewPage() {
  return <MiniAppFrame opener="the Edit button">{(tools) => <MiniAppEditor {...tools} />}</MiniAppFrame>;
}

function MiniAppEditor(tools: PanelTools) {
  const [{ postId, fromQueue }] = useState(() => ({
    postId: postIdFromLocation(),
    fromQueue: queueReturnUrl() !== null,
  }));

  // Telegram is ready by now: the frame renders this only once it is.
  useEffect(() => {
    const app = window.Telegram?.WebApp;
    if (app) offerBackToQueue(app);
  }, []);

  if (postId === null) return <p style={{ color: theme.hint }}>No post to edit.</p>;
  return (
    <PostEditor
      postId={postId}
      {...tools}
      onDone={() => {
        const app = window.Telegram?.WebApp;
        if (app) finishMiniApp(app);
      }}
      backTo={fromQueue ? 'the queue' : 'the chat'}
    />
  );
}
