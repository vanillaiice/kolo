/* Enhancement only: without JavaScript each walkthrough thumbnail links to YouTube. */

/**
 * Swap a pressed walkthrough thumbnail for the YouTube player. Nothing is requested from YouTube
 * before this click; the iframe autoplays so one press starts the video.
 */
for (const link of document.querySelectorAll('.walkthrough-thumb[data-embed]')) {
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const frame = document.createElement('iframe');
    frame.src = link.dataset.embed;
    frame.title = link.dataset.title;
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    link.replaceWith(frame);
    frame.focus();
  });
}
