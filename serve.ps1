$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd("\") + "\"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:8000/")
$listener.Start()

Write-Host "Mellowoku Web: http://127.0.0.1:8000/ (Ctrl+C to stop)"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $relativePath = [Uri]::UnescapeDataString(
                $context.Request.Url.AbsolutePath.TrimStart("/")
            ).Replace("/", "\")
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                $relativePath = "index.html"
            }

            $filePath = [System.IO.Path]::GetFullPath(
                (Join-Path $root $relativePath)
            )
            if (!$filePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                !(Test-Path -LiteralPath $filePath -PathType Leaf)) {
                $context.Response.StatusCode = 404
                $context.Response.Close()
                continue
            }

            $context.Response.ContentType = switch (
                [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
            ) {
                ".html" { "text/html; charset=utf-8" }
                ".js" { "text/javascript; charset=utf-8" }
                ".css" { "text/css; charset=utf-8" }
                ".png" { "image/png" }
                ".svg" { "image/svg+xml" }
                ".webmanifest" { "application/manifest+json" }
                ".ogg" { "audio/ogg" }
                ".mp3" { "audio/mpeg" }
                default { "application/octet-stream" }
            }
            $context.Response.Headers["Cache-Control"] = "no-cache"

            $contents = [System.IO.File]::ReadAllBytes($filePath)
            $context.Response.ContentLength64 = $contents.Length
            if ($context.Request.HttpMethod -eq "HEAD") {
                $context.Response.Close()
                continue
            }
            $context.Response.OutputStream.Write($contents, 0, $contents.Length)
            $context.Response.Close()
        } catch {
            $context.Response.StatusCode = 500
            $context.Response.Close()
            Write-Warning $_
        }
    }
} finally {
    $listener.Stop()
}
