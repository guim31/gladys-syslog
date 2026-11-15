# Syslog

Su router, su NAS, su SAI, sus switches y sus servidores escriben registros, y
casi todos saben enviarlos por la red con **syslog**. Esta integración convierte
Gladys en un receptor syslog: cada equipo que envía sus registros se convierte
en un dispositivo de Gladys con su último mensaje, su última gravedad y sus
errores de la última hora. Unas reglas detectan los mensajes importantes
(«conexión VPN», «fallo de disco», «corte de luz»…) y activan escenas, y un
widget del panel lista los últimos mensajes graves.

No se guarda nada: Gladys conserva en memoria el último mensaje de cada equipo,
los últimos mensajes graves y unos contadores. No es un archivo de registros
(para eso, vea Graylog).

Probado con emisores syslog reales (`logger`, rsyslog 8 como relé, RFC 3164 y
RFC 5424, UDP y TCP) contra la imagen Docker de la integración; todavía no en
una instancia real de Gladys: sus comentarios son bienvenidos en
[las issues](https://github.com/guim31/gladys-syslog/issues).

## Lo que necesita

- Gladys Assistant 5.2.0 o posterior.
- Equipos capaces de enviar sus registros a un «servidor syslog remoto», por UDP
  o TCP, con un puerto configurable. La mayoría de los routers, NAS (Synology,
  QNAP, TrueNAS…), programas de SAI (NUT, apcupsd), switches, cortafuegos y
  servidores Linux (rsyslog, syslog-ng, journald) pueden hacerlo.

## Primeros pasos

### 1. Instalar la integración

En Gladys, **Integraciones → Instalar desde GitHub**, dirección
`https://github.com/guim31/gladys-syslog`. La integración arranca dos
contenedores: la integración misma y un pequeño **receptor** que escucha syslog.
Gladys elige los puertos en los que el receptor está disponible, uno UDP y uno
TCP: la pantalla de configuración de la integración los muestra, en la sección
«Envíe sus registros a Gladys».

### 2. Apuntar sus equipos a Gladys

En los ajustes syslog (o «registro remoto») de cada equipo, indique la dirección
de la máquina de Gladys y el puerto UDP que muestra la pantalla de
configuración. UDP es lo que ofrecen casi todos los equipos; TCP (el segundo puerto) no pierde mensajes por el camino y conviene a rsyslog y syslog-ng. Se entienden las
dos divisiones TCP, «octet counting» y «un mensaje por línea».

En un servidor Linux con rsyslog, basta una línea en
`/etc/rsyslog.d/gladys.conf` (sustituya la dirección y el puerto):

```
*.* @192.168.1.10:41234
```

`@` envía por UDP, `@@` por TCP. Para probar desde cualquier máquina Linux:

```
logger -n 192.168.1.10 -P 41234 --udp "Hola Gladys"
```

### 3. Un equipo que solo envía al puerto 514

Algunos routers no dejan elegir el puerto: siempre envían al puerto 514. Dos
soluciones:

- **Un relé** (recomendado): un rsyslog que escucha en el puerto 514, en una
  máquina de la red (un NAS, una Raspberry Pi…), y lo reenvía todo a Gladys:

  ```
  module(load="imudp")
  input(type="imudp" port="514")
  *.* action(type="omfwd" target="192.168.1.10" port="41234" protocol="udp"
             template="RSYSLOG_SyslogProtocol23Format")
  ```

  Después indique la dirección IP del relé en **Relés de confianza**: los
  mensajes que reenvía se clasifican por el nombre de host que llevan, y cada
  equipo detrás del relé sigue siendo un dispositivo propio. (Sin esto, todos
  parecerían el relé.) Un relé en la propia máquina de Gladys llega al receptor
  a través de Docker, con otra dirección: el parámetro IP de los dispositivos
  que reenvió antes de que lo declarara la indica.

- **Una redirección de puerto** en la máquina de Gladys (iptables), del 514 al
  puerto elegido. En la mayoría de las instalaciones Docker oculta la dirección
  del emisor a la integración: es preferible el relé.

### 4. Añadir los dispositivos

Cada equipo que envía un mensaje aparece en la pestaña **Descubrir** de la
integración, con el nombre de host que envía (o su dirección IP). Añada los que
quiera seguir. La integración reconoce un equipo por su dirección IP: dé una
dirección fija a sus equipos (reserva DHCP).

El botón **Olvidar los emisores no añadidos** de la configuración vacía la
pestaña Descubrir de los equipos que no añadió; vuelven con su próximo mensaje.

## Configuración

- **Emisores permitidos**: direcciones IP o rangos IPv4 (`192.168.1.0/24`),
  separados por comas. Vacío: se acepta cualquier emisor. El receptor descarta un mensaje de otra dirección. Recomendado: syslog no tiene autenticación, y de lo contrario un equipo de la red podría llenar los 200 emisores con direcciones falsificadas.
- **Relés de confianza**: vea más arriba.
- **Mensajes por segundo por emisor** (20 por defecto): por encima, los mensajes
  de ese emisor se descartan (se acepta una ráfaga del doble). Un equipo
  desbocado no puede saturar Gladys. El receptor acepta además 500 mensajes por
  segundo como máximo, todos los emisores juntos.
- **Idioma de los nombres y textos**: los nombres de las funciones (fijados al
  añadir un dispositivo), las gravedades y las variables de escena.
- **Reglas**: hasta cinco, vea más abajo.

## Gravedades

Cada mensaje syslog lleva una gravedad, de la más a la menos grave: Emergencia,
Alerta, Crítico, Error, Advertencia, Aviso, Información, Depuración. Un mensaje
sin gravedad cuenta como Aviso. La integración llama «grave» a un mensaje desde
Advertencia, y «error» a un mensaje desde Error.

## Los dispositivos

Cada emisor:

- **Último mensaje**: el programa y el texto de su último mensaje.
- **Última gravedad**: la gravedad de su último mensaje.
- **Errores en la última hora**: sus mensajes Error o más graves de los últimos
  60 minutos.
- **Visto por última vez**: la hora de su último mensaje.

El dispositivo **Reglas syslog** tiene un contador por regla, con el nombre de
la regla: los mensajes que coincidieron con ella en los últimos 60 minutos.
Úselos en las condiciones de escena («más de 5 inicios de sesión fallidos en la
última hora»).

Los estados se envían a Gladys como mucho cada 15 segundos, solo cuando
cambian: Gladys acepta 300 estados por minuto.

## Reglas

Una regla tiene:

- un **nombre**, el de su contador y una variable de su disparador de escena;
- un **texto**, buscado en el mensaje sin distinguir mayúsculas, o una
  **expresión regular** entre barras: `/disk \S+ failed/i` (`i`: sin distinguir
  mayúsculas). El mensaje se lee como `programa: texto`, así que una regla
  puede nombrar el programa: `openvpn: .* Peer Connection Initiated`;
- una **gravedad** mínima (Cualquiera por defecto);
- **emisores** opcionales: direcciones IP o nombres de host, separados por
  comas.

Ejemplos: `Peer Connection Initiated` (conexión OpenVPN), `on battery` (NUT,
corte de luz), `authentication failure` (inicio de sesión fallido),
`/ata\d.*failed/` (error de disco en el registro del núcleo).

## Panel

El widget **Mensajes graves** muestra:

- los errores de la última hora, todos los emisores juntos;
- los últimos mensajes graves, los más recientes primero: el texto, el emisor y
  la hora, la gravedad como distintivo de color; toque un mensaje para leerlo
  entero;
- un botón **Borrar**: una vez leída, la lista solo muestra los mensajes
  nuevos.

Ajustes: los emisores (vacío: todos), la gravedad mínima mostrada (Error por
defecto), e interruptores para ocultar el contador y el botón Borrar. Los
mensajes graves solo se guardan en memoria: un reinicio de la integración vacía
la lista.

## Escenas

### Disparadores

- **Una regla coincide**: un mensaje coincide con una regla. Filtros: las
  reglas, los emisores. Variables: nombre de la regla, emisor, dirección IP,
  gravedad, programa, mensaje.
- **Llega un mensaje grave**: un emisor registra una Advertencia o algo más
  grave. Filtros: las gravedades, los emisores. Las mismas variables, sin la
  regla.
- **Aparece un nuevo emisor**: un equipo nunca visto envía su primer mensaje (un
  equipo nuevo en la red, o uno mal configurado). Variables: emisor, dirección
  IP.

Para evitar avalanchas, un disparador se activa como mucho cada 10 segundos para
la misma regla y el mismo emisor (o el mismo emisor y la misma gravedad), y la
integración envía 120 eventos de escena por minuto como máximo.

### Ideas de escenas

- «Corte de luz»: regla `on battery` → enviar un mensaje y apagar lo que se
  pueda.
- «Alguien se conectó a la VPN»: regla `Peer Connection Initiated` → una
  notificación con `{{triggerEvent.data.message}}`.
- «El NAS señala un error de disco»: el disparador «Llega un mensaje grave»,
  gravedades Crítico y Error, emisor el NAS.

## Solución de problemas

- **No aparece ningún dispositivo**: compruebe que el equipo envía al puerto
  correcto (el de la pantalla de configuración, no el 514) y a la dirección IP
  de la máquina de Gladys; pruebe con `logger` desde un ordenador. Compruebe los
  Emisores permitidos.
- **La pantalla de configuración muestra `{{port:syslog_udp}}`**: el receptor
  todavía no ha arrancado; recargue la página unos segundos después de la
  instalación.
- **Todos los dispositivos tienen la misma dirección**: pasan por un relé, o
  Gladys ejecuta Docker con una red que oculta la dirección del emisor. Use los
  Relés de confianza.
- **Faltan mensajes**: un emisor por encima de su límite se señala en los
  registros de la integración; aumente «Mensajes por segundo por emisor». UDP
  puede perder mensajes en una red cargada: use TCP.
- **El estado está en rojo**: el contenedor del receptor no está en marcha (la
  integración lo vuelve a arrancar sola), una expresión regular de una regla no
  es válida, o un emisor permitido no se entiende: el mensaje dice cuál.

## Límites

- La hora de un mensaje es la de su recepción: los relojes de los equipos
  suelen estar mal, y el antiguo formato syslog no tiene ni año ni zona horaria.
- Un equipo se reconoce por su dirección IP: un equipo cuya dirección cambia
  vuelve a aparecer en Descubrir.
- Sin TLS (syslog sobre TLS, puerto 6514): el receptor está pensado para la red
  local.
- 200 emisores como máximo; los mensajes se cortan a 2048 caracteres.
- No se archiva nada: para buscar en registros antiguos, use un servidor de
  registros (Graylog…).
- Sin relación con ninguna de las marcas citadas.
