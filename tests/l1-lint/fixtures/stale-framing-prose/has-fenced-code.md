# Fixture: fenced code allowed, prose after the fence caught

```
status TEXT CHECK (status IN ('active', 'retired'))
```

~~~sql
-- deprecated column kept for old rows
~~~

This API was previously the default.
