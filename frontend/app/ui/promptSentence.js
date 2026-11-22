// The article for "Today I want to be a/an ___". Pure, so it can be tested without a browser.
/** "a" or "an" for the job as typed; none when the player already wrote an article. */
export function articleFor(job) {
  const j = job.trim().toLowerCase();
  if (/^(a|an|the)\s/.test(j)) return '';
  // Sound, not spelling, for the common exceptions: an hour, an MRI; a university, a European, a one-off.
  if (/^(hour|honest|honou?r|heir|mri|mr\b|x-?ray|fbi)/.test(j)) return 'an';
  if (/^(uni|use|usu|euro|one\b|once)/.test(j)) return 'a';
  return /^[aeiou]/.test(j) ? 'an' : 'a';
}
