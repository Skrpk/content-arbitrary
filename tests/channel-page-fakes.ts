/**
 * A public channel's web page, in the markup t.me serves (trimmed to what the
 * parser reads, with the structure kept: bubble, media containers, the
 * "not supported" fallback every post carries, footer). The text is our own.
 */

export interface FakeMessage {
  channel?: string;
  id: number;
  text?: string;
  /** Photo URLs; more than one makes an album whose items are messages id, id+1… */
  photos?: string[];
  video?: { src: string | null; thumb?: string; duration?: string };
  forwarded?: boolean;
  poll?: boolean;
  /** A reply preview, quoting another post with a picture of its own. */
  replyTo?: number;
  linkPreview?: boolean;
  views?: string;
  date?: string;
}

export const CDN = 'https://cdn4.telesco.pe/file';

export function channelMessage(message: FakeMessage): string {
  const channel = message.channel ?? 'spacenews';
  const link = `https://t.me/${channel}/${message.id}`;
  const photos = message.photos ?? [];

  const photo = (url: string, index: number) =>
    `<a class="tgme_widget_message_photo_wrap${photos.length > 1 ? ' grouped_media_wrap blured js-message_photo' : ''}" ` +
    `style="width:800px;background-image:url('${url}')" href="${photos.length > 1 ? `https://t.me/${channel}/${message.id + index}?single` : link}">` +
    '<div class="tgme_widget_message_photo" style="padding-top:56.25%"></div></a>';

  const media =
    photos.length > 1
      ? '<div class="tgme_widget_message_grouped_wrap js-message_grouped_wrap"><div class="tgme_widget_message_grouped">' +
        `<div class="tgme_widget_message_grouped_layer">${photos.map(photo).join('')}</div></div></div>`
      : photos.map(photo).join('');

  const video = message.video
    ? `<a class="tgme_widget_message_video_player${message.video.src ? '' : ' not_supported'} js-message_video_player" href="${link}">` +
      `<i class="tgme_widget_message_video_thumb" style="background-image:url('${message.video.thumb ?? `${CDN}/thumb.jpg`}')"></i>` +
      '<div class="tgme_widget_message_video_wrap">' +
      (message.video.src ? `<video src="${message.video.src}" class="tgme_widget_message_video js-message_video"></video>` : '') +
      '</div>' +
      `<time class="message_video_duration js-message_video_duration">${message.video.duration ?? '0:12'}</time>` +
      (message.video.src
        ? ''
        : '<div class="message_media_not_supported_wrap"><div class="message_media_not_supported">' +
          '<div class="message_media_not_supported_label">Media is too big</div></div></div>') +
      '</a>'
    : '';

  const reply = message.replyTo
    ? `<a class="tgme_widget_message_reply" href="https://t.me/${channel}/${message.replyTo}">` +
      `<i class="tgme_widget_message_reply_thumb" style="background-image:url('${CDN}/reply.jpg')"></i>` +
      '<div class="tgme_widget_message_text js-message_text">The quoted post</div></a>'
    : '';

  const text = message.text === undefined ? '' : `<div class="tgme_widget_message_text js-message_text" dir="auto">${message.text}</div>`;

  const preview = message.linkPreview
    ? '<a class="tgme_widget_message_link_preview" href="https://example.org/story">' +
      `<i class="link_preview_image" style="background-image:url('${CDN}/preview.jpg')"></i>` +
      '<div class="link_preview_title">A linked story</div></a>'
    : '';

  const poll = message.poll
    ? '<div class="tgme_widget_message_poll js-poll"><div class="tgme_widget_message_poll_question">Which?</div></div>'
    : '';

  return (
    '<div class="tgme_widget_message_wrap js-widget_message_wrap">' +
    `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${channel}/${message.id}">` +
    '<div class="tgme_widget_message_bubble">' +
    `<div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name" href="https://t.me/${channel}"><span dir="auto">Space News</span></a></div>` +
    (message.forwarded
      ? '<div class="tgme_widget_message_forwarded_from">Forwarded from&nbsp;<a class="tgme_widget_message_forwarded_from_name" href="https://t.me/other/1"><span>Other</span></a></div>'
      : '') +
    reply +
    `<div class="media_supported_cont">${media}${video}${poll}${text}</div>` +
    '<div class="media_not_supported_cont"><div class="message_media_not_supported_wrap"><div class="message_media_not_supported">' +
    `<div class="message_media_not_supported_label">Please open Telegram to view this post</div><a href="${link}" class="message_media_view_in_telegram">VIEW IN TELEGRAM</a></div></div></div>` +
    preview +
    '<div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">' +
    `<span class="tgme_widget_message_views">${message.views ?? '1.2K'}</span><span class="copyonly"> views</span>` +
    `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="${link}"><time datetime="${message.date ?? '2099-01-15T12:00:00+00:00'}" class="time">12:00</time></a></span>` +
    '</div></div></div></div></div>'
  );
}

/** The channel's page: its header, then its messages oldest first, as t.me lists them. */
export function channelPage(messages: FakeMessage[], title = 'Space News', username = 'spacenews'): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Space News – Telegram</title></head><body>' +
    '<div class="tgme_channel_info"><div class="tgme_channel_info_header">' +
    `<div class="tgme_channel_info_header_title"><span dir="auto">${title}</span></div>` +
    `<div class="tgme_channel_info_header_username"><a href="https://t.me/${username}">@${username}</a></div>` +
    '</div></div><main><section class="tgme_channel_history js-message_history">' +
    messages.map(channelMessage).join('\n') +
    '</section></main></body></html>'
  );
}

/** One post's embed: the message alone, no channel header. */
export function channelEmbed(message: FakeMessage): string {
  return `<!DOCTYPE html><html><body class="widget_frame_base tgme_widget body_widget_post">${channelMessage(message)}</body></html>`;
}
