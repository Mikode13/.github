include "version";
def fail($message): error($message);
def payload_path:
  startswith("skills/") or startswith(".claude-plugin/") or
  startswith(".codex-plugin/") or startswith(".agents/plugins/") or
  . == "AGENTS.md" or . == "CLAUDE.md" or . == "LICENSE";
def inventory($snapshot):
  $snapshot.tree | map(select(.type != "tree" and (.path | payload_path)) |
    if .path == ".claude-plugin/plugin.json" then .sha = ($snapshot.claude | del(.version))
    elif .path == ".codex-plugin/plugin.json" then .sha = ($snapshot.codex | del(.version))
    else . end) | sort_by(.path);

# An unchanged bundle on an older PR inherits current main's adoption/repair at merge.
# Do not require that old head to satisfy a manifest contract it has never changed.
if .context.event != "push" and .context.target != null and .context.base != .context.target and
  inventory(.base) == inventory(.head) and .base.claude == .head.claude and .base.codex == .head.codex
then {context: .context, previous: .base.claude.version, version: .head.claude.version,
  increment: "none", payload_changed: false, base_repair: false, needs_update: false,
  manifests: {claude: .head.claude, codex: .head.codex}}
else
(.head.claude | validate_manifest) as $head_claude |
(.head.codex | validate_manifest) as $head_codex |
if $head_claude.name != $head_codex.name then fail("Host manifests must name the same plugin") else . end |
(.base.claude == null and .base.codex == null) as $initial |
(.base | previous_version) as $previous |
((.base.claude == null or .base.codex == null or
  .base.claude.version != .base.codex.version or .base.claude.name != .base.codex.name)
  and ($initial | not)) as $base_repair |
(inventory(.base) != inventory(.head)) as $payload_changed |
(.context.title | test("^[a-z]+(\\([^\\r\\n)]+\\))?!: ")) as $breaking_title |
(.context.body | test("(^|\\n)BREAKING[ -]CHANGE: \\S")) as $breaking_body |
(if $initial then "initial"
 elif ($payload_changed | not) then "none"
 elif $breaking_title or $breaking_body then "major"
 elif (.context.title | test("^feat(\\([^\\r\\n)]+\\))?: ")) then "minor"
 elif (.context.title | test("^fix(\\([^\\r\\n)]+\\))?: ")) then "patch"
 else "none" end) as $increment |
if .context.event != "push" and $payload_changed and $increment == "none"
then fail("Distributed plugin content changed. Use fix:, feat:, or a breaking-change marker in the PR title/body")
else . end |
(if .context.event == "push" then
  if $head_claude.version != $head_codex.version then fail("Published host versions must agree")
  elif $initial then
    if $head_claude.version == "0.1.0" then "0.1.0" else fail("Initial version must be 0.1.0") end
  elif $payload_changed then
    ["patch", "minor", "major"] | map(next_version($previous; .)) |
    if index($head_claude.version) != null then $head_claude.version
    else fail("Published content needs exactly one patch, minor, or major increment") end
  elif $head_claude.version == $previous then $previous
  else fail("Unchanged content must preserve the previous version") end
else next_version($previous; $increment) end) as $version |
($version | semver) as $validated_version |
{
  context: .context,
  previous: $previous,
  version: $version,
  increment: (if .context.event == "push" and $payload_changed and ($initial | not)
    then ["patch", "minor", "major"] | map(select(next_version($previous; .) == $version))[0]
    else $increment end),
  payload_changed: $payload_changed,
  base_repair: $base_repair,
  needs_update: ($head_claude.version != $version or $head_codex.version != $version),
  manifests: {claude: ($head_claude | .version = $version), codex: ($head_codex | .version = $version)}
}
end
