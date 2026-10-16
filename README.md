# omp-discord

Extensión de Discord Rich Presence para **Oh My Pi (`omp`)**. No instala dependencias: habla con el cliente de Discord de escritorio por IPC local.

Con Discord abierto, el perfil queda así:

```text
VibeCoding With grok-4
Proyecto: omp-discord
En espera
4:03
```

- El título es `appName` más el modelo activo (`VibeCoding With grok-4`). Si el id trae proveedor (`openrouter/x-ai/grok-4`), se muestra solo `grok-4`.
- La segunda línea es el proyecto (`cwd`).
- La tercera es la actividad: `Pensando...`, `Editando archivo.ts`, `Leyendo archivo.ts`, `Ejecutando comando`, `Explorando el código`, `Coordinando subagentes` o `En espera`.
- El tiempo de abajo es el de la sesión. Tras 10 minutos en espera, la presencia se oculta.

## Instalación

### Desde Git

Clona el repositorio e instálalo como plugin. `omp` lo enlaza y lo carga en las sesiones siguientes:

```sh
git clone <url-de-este-repositorio> omp-discord
cd omp-discord
omp plugin install .
```

Si está en GitHub, el atajo equivalente es:

```sh
omp plugin install github:<usuario>/omp-discord
```

Reinicia `omp` después de instalar. Un `omp` que ya estaba abierto no carga la extensión nueva hasta ese reinicio.

### Solo esta sesión

Desde la raíz del repo, sin dejarla instalada:

```sh
omp --extension ./src/index.ts
```

## Primer uso

Dentro de `omp`:

```text
/discord start
```

Ese comando escribe `~/.omp/agent/discord-presence.json` con la configuración por defecto, lo aplica y activa la presencia. Si el archivo ya existe, conserva sus valores, pone `enabled` en `true` y vuelve a publicarla.

La presencia también arranca sin ese archivo: usa los valores por defecto que trae el código. El JSON solo se crea cuando `/discord` guarda un cambio.

Si definiste `PI_CODING_AGENT_DIR`, el archivo queda en ese directorio como `discord-presence.json`.

## Comandos

- `/discord` o `/discord status`: estado de la conexión IPC y la configuración actual. No escribe el JSON.
- `/discord start`: crea o reescribe el JSON, lo aplica y activa la presencia.
- `/discord on` | `/discord off`: activa o desactiva la presencia y guarda `enabled`.
- `/discord privacy <full|moderate|private>`:
  - `full`: proyecto, archivo o herramienta, y modelo en el título.
  - `moderate`: proyecto y modelo. La actividad pasa a `Agente trabajando`.
  - `private`: solo `Programando con omp` y el tiempo. El título queda en `VibeCoding`, sin modelo.
- `/discord idle <minutos>`: minutos en espera antes de ocultar la presencia. `0` no la oculta nunca.
- `/discord client-id <id>`: Application ID de tu app en el Discord Developer Portal.

## Configuración

`/discord start` deja este archivo en `~/.omp/agent/discord-presence.json`:

```json
{
  "enabled": true,
  "clientId": "782685898163617802",
  "appName": "VibeCoding",
  "privacy": "full",
  "showProject": true,
  "showDetails": true,
  "showModel": true,
  "idleTimeoutMinutes": 10,
  "largeImageKey": "https://omp.sh/favicon-512x512.png",
  "largeImageText": "Oh My Pi (omp.sh)"
}
```

`appName` es el título. Con `showModel` en `true` se le añade ` With <modelo>`. `largeImageKey` es el icono grande.

Estas variables pisan el archivo al cargar la sesión, pero no se guardan dentro de él:

- `OMP_DISCORD_CLIENT_ID`: Client ID de Discord.
- `OMP_DISCORD_ENABLED`: `true`/`1` o `false`/`0`.
- `OMP_DISCORD_PRIVACY`: `full`, `moderate` o `private`.
