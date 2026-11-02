# Playnite -> Hub (live "Playing now" + "Last played"), no git needed.
# Playnite: Settings > Scripting > "Global script"  -> paste this whole file.
# Fill the two values below (HUB_SECRET must be the same value you put in Vercel).

$HubUrl    = "https://uwaazy.vercel.app/api/activity"
$HubSecret = "PUT_YOUR_HUB_SECRET_HERE"

function Send-Hub($payload) {
    try {
        Invoke-RestMethod -Method Post -Uri $HubUrl -TimeoutSec 10 `
            -Headers @{ Authorization = "Bearer $HubSecret" } `
            -ContentType "application/json" -Body ($payload | ConvertTo-Json -Compress) | Out-Null
    } catch {
        $PlayniteApi.Notifications.Add("hub-push", "Hub push failed: $($_.Exception.Message)", [Playnite.SDK.NotificationType]::Error) | Out-Null
    }
}

function Get-SourceName($game) { if ($game.Source) { $game.Source.Name } else { "" } }

function OnGameStarted($evnArgs) {
    $g = $evnArgs.Game
    Send-Hub @{
        state     = "playing"
        name      = $g.Name
        source    = (Get-SourceName $g)
        sourceId  = "$($g.GameId)"
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
}

function OnGameStopped($evnArgs) {
    $g = $evnArgs.Game
    Send-Hub @{
        state      = "idle"
        name       = $g.Name
        source     = (Get-SourceName $g)
        sourceId   = "$($g.GameId)"
        totalHours = [math]::Round($g.Playtime / 3600, 1)
    }
}
