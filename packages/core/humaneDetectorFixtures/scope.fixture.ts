/**
 * Sample sources for SCOPE — which files the detectors agree to look at at all.
 *
 * These fixtures are not about a principle. They are about the two ways a scanner lies:
 * by looking at a file it does not understand, and by looking at a file nobody shipped.
 * Both produce false positives, which is the failure this module treats as fatal.
 *
 * Every fixture here is deliberately BAIT: run against a path the scanner does understand,
 * each one produces a finding. That is what makes the silence assertions meaningful — the
 * silence has to come from scope, not from inert content.
 */

// --- markup the scanner does not understand --------------------------------------------

/**
 * A commented-out image, in HTML comment syntax.
 *
 * `scanSource` blanks `//` and comment blocks because a commented-out `<img>` is not a
 * shipped `<img>`. It has never understood `<!-- ... -->`, so in a markup file that
 * rationale silently inverts: the dead banner below reads as live markup and fires
 * `meaningful-image-no-alt` on code that ships to nobody.
 */
export const markupCommentedOutImage = `<section class="promo">
  <!-- <img src="/old-hero.png"> we dropped this banner last quarter -->
  <p>Nothing to see here.</p>
</section>
`;

/**
 * A bare URL in an unquoted attribute, which is legal in HTML and meaningless in JS.
 *
 * The `//` in `https://` opens a line comment as far as `scanSource` is concerned, so the
 * rest of that line — including `alt="Product hero"` and the tag's own closing bracket —
 * is blanked out of `ctx.code`. What the detectors then see is an `<img>` with no alt that
 * runs on until the next `>` it can find. The author wrote the alt text; the scanner ate
 * it, and the gate blames them for it.
 */
export const markupBareUrlEatsAlt = `<figure class="hero">
  <img src=https://cdn.example.com/hero.png alt="Product hero">
  <figcaption>The team at work</figcaption>
</figure>
`;
