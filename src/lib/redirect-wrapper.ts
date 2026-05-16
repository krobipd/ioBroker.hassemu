import { escapeHtml } from './coerce';
import { CONNECTION_STATUS_SCRIPT } from './external-bridge';

/**
 * HTML-Wrapper statt 302-Redirect (A3 / v1.7.0). Display lädt das HTML einmal,
 * sieht den Target im iframe, polled `/api/redirect_check` alle 30s. Bei
 * Target-Wechsel (User edit) macht es `location.reload()` und bekommt das
 * neue iframe-Target.
 *
 * `target` muss bereits durch `coerceSafeUrl` validiert sein (Resolver garantiert
 * das). Der Wrapper escaped trotzdem — defense in depth.
 *
 * v1.32.0: aus `webserver.ts` ausgelagert für Symmetrie zu `landing-page.ts` /
 * `auth-page.ts`. `escapeHtml` ist shared helper aus `coerce.ts`.
 *
 * @param target Vom Resolver gelieferte Ziel-URL.
 */
export function renderRedirectWrapper(target: string): string {
    // Conservative HTML-attribute escape via shared helper. Sicherheits-relevant
    // weil target letztlich aus user-konfigurierten States stammt.
    const escAttr = escapeHtml(target);
    const escJs = JSON.stringify(target); // safe for inline JS string literal
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>ioBroker HASS Emulator</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
/* display:block kills the inline-baseline gap below the iframe; position:fixed +
   100vw/100vh nimmt das Display sicher voll aus, auch wenn ein WebView die
   100%-Berechnung subpixel-falsch macht (Shelly Wall Display zeigte sonst
   einen schwarzen Streifen rechts/unten). */
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;}
</style>
</head>
<body>
<iframe src="${escAttr}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
${CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&typeof j.target==='string'&&j.target&&j.target!==current){
          location.reload();
        }
      })
      .catch(function(){/* silent — broker hiccup, retry next tick */});
  },30000);
})();
</script>
</body>
</html>`;
}
