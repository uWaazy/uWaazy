# Playnite -> Wagner Hub
# Paste into Playnite: Settings > Scripting > "Global script" (keep the functions below).
# Exports your 3 most recently played games (+ cover art) and pushes to GitHub, so the hub updates itself.

$HubRepo = "C:\path\to\wagner-hub"   # <-- CHANGE THIS to your local clone

function Export-Hub {
    $recent = $PlayniteApi.Database.Games | Where-Object { $_.LastActivity } |
              Sort-Object LastActivity -Descending | Select-Object -First 3
    $out = @()
    foreach ($g in $recent) {
        $cover = $null
        if ($g.CoverImage) {
            $src  = $PlayniteApi.Database.GetFullFilePath($g.CoverImage)
            $slug = ($g.Name -replace '[^a-zA-Z0-9]+', '-').Trim('-').ToLower()
            $dest = "assets/games/$slug$([IO.Path]::GetExtension($src))"
            Copy-Item $src (Join-Path $HubRepo $dest) -Force
            $cover = $dest
        }
        $out += [ordered]@{
            name     = $g.Name
            cover    = $cover
            playedAt = $g.LastActivity.ToUniversalTime().ToString("o")
            hours    = [math]::Round($g.Playtime / 3600, 1)
        }
    }
    [ordered]@{ updatedAt = (Get-Date).ToUniversalTime().ToString("o"); recent = $out } |
        ConvertTo-Json -Depth 5 | Set-Content (Join-Path $HubRepo "data\games.json") -Encoding UTF8
    git -C $HubRepo add -A | Out-Null
    git -C $HubRepo commit -m "chore: sync games" -q
    git -C $HubRepo push -q
}

function OnGameStopped($evnArgs)   { Export-Hub }
function OnApplicationStopped()    { Export-Hub }
