package io.github.mathr81.spicylyrics;

import android.service.notification.NotificationListenerService;

/**
 * Empty on purpose. Android lets an app see other apps' media sessions only if
 * it owns a notification listener the user has enabled; this is that listener,
 * and MainActivity reads Spotify's session through it. It handles no
 * notification.
 */
public class MediaLink extends NotificationListenerService {
}
