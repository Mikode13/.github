# Source and documentation fixture

This fixture is checked by the Source capability and the Documentation capability in the
same run. Both format the Markdown below, so any disagreement between them fails this
fixture instead of reaching a consuming repository.

Every code block here is deliberately something the shared formatter has an opinion about.
Prettier's own defaults would rewrite all three, which is what makes this fixture a
regression test rather than decoration.

```js
export function greet(name) {
	return `hello ${name}`;
}
```

```json
{
	"name": "example",
	"private": true
}
```

```yaml
jobs:
  ci:
    with:
      documentation: true
      source: true
```

See the [authoring guide](guides/authoring.md#embedded-code-examples) for the invariant
this fixture exists to protect.
