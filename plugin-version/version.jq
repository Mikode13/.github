# Numeric versions shared by planning, definitive-commit validation and publication.
def semver:
  if type != "string" then error("Plugin versions must be numeric MAJOR.MINOR.PATCH")
  elif test("^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$")
  then split(".") | map(tonumber)
  else error("Plugin versions must be numeric MAJOR.MINOR.PATCH (up to nine digits per component)")
  end;
def version_string: map(tostring) | join(".");
def validate_manifest:
  if type != "object" then error("Both plugin manifests must be JSON objects")
  elif (.name | type) != "string" then error("Each plugin manifest needs a name")
  elif ((.name | test("^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$")) | not) then error("Invalid plugin name")
  else (.version | semver) as $version | . end;
def previous_version:
  [.claude, .codex] | map(select(. != null) | .version | semver) |
  if length == 0 then null else max | version_string end;
def next_version($previous; $increment):
  if $previous == null then "0.1.0" else
    ($previous | semver) |
    if $increment == "major" then [.[0] + 1, 0, 0]
    elif $increment == "minor" then [.[0], .[1] + 1, 0]
    elif $increment == "patch" then [.[0], .[1], .[2] + 1]
    else . end | version_string
  end;
