Pulse on Ubuntu
============================

1. Copy and unpack (from your Windows PC, e.g. with pscp from the PuTTY package, or WinSCP):
     pscp playprobe-linux.tar.gz USER@SERVER_IP:/home/USER/
   then on the server (PuTTY):
     mkdir -p ~/playprobe && tar -xzf playprobe-linux.tar.gz -C ~/playprobe && cd ~/playprobe

2. One-time setup (installs ffmpeg + SRT tools with apt, and Node 22 into this folder):
     bash setup-ubuntu.sh

3. Run:
     ./start.sh
   To keep it running after the terminal closes, restart it if it crashes and start it at boot, use the
   systemd unit playprobe.service (edit User= and the paths, then see the three commands at its top).
   It opens the page on the server IP (HOST=0.0.0.0); logs of the service: journalctl -u playprobe -f

4. Open the page from your PC with an SSH tunnel (nothing is exposed to the network, and the
   page is plain HTTP, so do NOT bind it to a public address):
     PuTTY > Connection > SSH > Tunnels:  Source port 4173, Destination 127.0.0.1:4173, Add, then Open the session
   (or from a Windows terminal:  ssh -L 4173:127.0.0.1:4173 USER@SERVER_IP)
   Then browse to  http://localhost:4173/  on your PC.
   To open it by the server IP instead (trusted network only):  PULSE_USER=you PULSE_PASSWORD=secret HOST=0.0.0.0 ./start.sh  then  http://SERVER_IP:4173/

   Sign-in: the page asks for a user name and password. Choose them with PULSE_USER and PULSE_PASSWORD
   (as a service: two Environment= lines in playprobe.service). If you set nothing, it is  skandha / skandha@123
   (built in, the same on every machine). Signing in lasts
   12 hours (PULSE_SESSION_HOURS), five wrong passwords lock that address for a minute, and restarting
   Pulse signs everyone out. The password travels unencrypted over http://, so keep to a trusted network
   or the SSH tunnel above (or put an https reverse proxy in front).

5. SRT:
   - Caller mode (PlayProbe connects out to a source): nothing to open on the server.
   - Listener mode (an encoder pushes to the server): open the port on the server's firewall, as UDP:
       sudo ufw allow 9101/udp
     and point the encoder at srt://SERVER_IP:9101 (mode caller). Cloud servers also need the port
     opened in their security group.

6. Check the load while channels run:
     ./load-report.sh 5
   (the SRT panel in the web page also shows machine / server / ffmpeg load live), or  htop .

Files, all created in this folder:
  logs/<date>/all-channels.log   the alerts of every channel (and server messages)
  logs/<date>/<channel name>.log everything about one channel, named after it, continued when it is stopped and started
  .playprobe/                    settings, layouts (may contain the Slack webhook)
Old log days are not deleted: remove logs/<old date>/ folders now and then.
Set the Slack webhook once in the Alerts tab, or start with  SRT_WEBHOOK_URL=... ./start.sh
(as a service: add a line  Environment=SRT_WEBHOOK_URL=...  to playprobe.service). The server needs internet access to Slack.
Environment: PORT (default 4173), HOST (default 127.0.0.1), PULSE_USER, PULSE_PASSWORD, PULSE_SESSION_HOURS (PULSE_AUTH=off turns the sign-in off).
