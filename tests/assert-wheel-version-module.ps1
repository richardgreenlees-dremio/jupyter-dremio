$package = Get-Content package.json -Raw | ConvertFrom-Json

if ($package.scripts.'clean:labextension' -match '_version\.py') {
  throw 'clean:labextension must not delete jupyter_dremio/_version.py'
}
