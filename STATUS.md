# Decypharr fork — stand van zaken

Branch: `claude/repository-bewerken-0sscnx` (fork `reugabronk/decypharr`, basis v2.5-stable)

## Opstelling

Docker: decypharr + Sonarr/Radarr/Prowlarr/Jellyfin. TorBox als enige provider,
voor zowel torrents (debrid) als usenet (NNTP, 10 verbindingen).
Mount `/mnt/hdd/decypharr/mount`, symlinks `/mnt/hdd/decypharr/symlinks`,
bibliotheek `/mnt/hdd/data/media/series`.

Arr-koppeling: qBittorrent-client op poort 8282 (torrents) + SABnzbd-client op
8282 met URL base `/sabnzbd` (usenet). Bij de SABnzbd-client is username = de
URL van de Arr zelf, password = de API-key van die Arr.

## Commits (nieuwste eerst)

| Commit | Wat |
|---|---|
| ff803fc | API-token gemaskeerd in de requestdl-fallbacklog |
| 227aa5e | `IsDownloading`-vlag wissen bij herstart (entries bleven op 100% hangen) |
| eb958fc | `stalled` telt als downloadend, niet als fout |
| 590f7de | TorBox' eigen state + seeders in de foutmelding |
| d5a166e | HTTP/2-gezondheidscontrole: dode verbindingen worden weggegooid |
| 2a889c4 + b6ab793 | Ruimere timeouts voor trage createtorrent-verzoeken |
| cc4053e | Mislukte beschikbaarheidssweep keurt geen release meer af |
| 86b91fc | Kapot-markering vervalt na 30 min en wordt gelogd |
| 50d6e73 | Geen dubbele categorieën in de Arr-dropdown |
| 90e69ad | Verificatiefout zegt wát er binnenkwam (RAR, PAR2, HTML) |
| 6f40e3d | Verlopen links worden ververst; CDN-URL max 1 uur gecached |
| 17a7269 | CDN-URL één keer ophalen i.p.v. per read (stopt 429-stormen) |
| 3c3248b | Tijdelijke 5xx niet meer als permanent gecached (het oorspronkelijke ffprobe-probleem) |

Alles heeft tests behalve 227aa5e (vereist een volledige Manager).

## Instellingen die ertoe doen

- `usenet.max_connections` 4–8, `processing_max_connections` 4 — samen onder de 10
- `import_availability_sample_percent` **10** (op 100 knijpt TorBox af: 930 van 1050 probes mislukt)
- `availability_sample_percent` (repair) 10–25
- `max_active_downloads` 1
- `download_uncached` aan, anders alleen wat al in TorBox' cache staat
- Sonarr → Indexers → **Minimum Seeders 5**, scheelt halfdode torrents

## Openstaand

1. **TorBox was gedegradeerd op 5 sep 's avonds**: 502's op de CDN, `status=0`
   op requestdl, 430-stormen op NNTP. Tien FROM-afleveringen bleven op
   "waiting for import". Eerst opnieuw testen voordat er iets gezocht wordt.
2. **Weesymlinks**: niets vergelijkt de bibliotheek met bestaande entries. Een
   verwijderde entry laat een dode symlink achter (upstream #244/#193). Nog niet
   gebouwd.
3. Niet gebouwd uit het onderzoek: #317 relatieve symlinks, #166 repareren
   zonder opnieuw te zoeken.

## Diagnose-commando's

```bash
# draait de juiste build?
docker exec decypharr grep -c "torbox state" /usr/bin/decypharr

# waarom faalt een usenet-bestand?
docker logs decypharr --since 10m 2>&1 | grep -iE "Marking file as failed|inconclusive|article"

# is een bestand leesbaar, en tot waar?
dd if="<pad>" of=/dev/null bs=1M status=progress

# usenet of torrent?
ls /mnt/hdd/decypharr/mount/nzbs/ | grep -i "<naam>"
ls /mnt/hdd/decypharr/mount/torrents/ | grep -i "<naam>"
```

## Les van de eerste dag

Usenet via TorBox werkt alleen voor recente content; alles van vóór hun
retentie (2017 bleek ruim te oud) faalt met `ARTICLE_NOT_FOUND` bij het
toevoegen. Oude series haal je via torrents, met `download_uncached` aan.
