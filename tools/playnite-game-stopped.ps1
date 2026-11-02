$HubUrl    = "https://uwaazy.vercel.app/api/activity"
$HubSecret = "PUT_YOUR_HUB_SECRET_HERE"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $src = ""; if ($Game.Source) { $src = $Game.Source.Name }
    $json = @{
        state      = "idle"
        name      = $Game.Name
        source    = $src
        sourceId  = "$($Game.GameId)"
        totalHours = [math]::Round($Game.Playtime / 3600, 1)
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri $HubUrl -TimeoutSec 10 `
        -Headers @{ Authorization = "Bearer $HubSecret" } `
        -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
} catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail += " | " + $_.ErrorDetails.Message }
    $PlayniteApi.Notifications.Add("hub-push", "Hub push failed: $detail", [Playnite.SDK.NotificationType]::Error) | Out-Null
}
