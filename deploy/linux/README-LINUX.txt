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
   Keep the PuTTY window open, or use  nohup ./start.sh > playprobe.out 2>&1 &  to leave it running,
   or the systemd unit in playprobe.service.

4. Open the page from your PC with an SSH tunnel (nothing is exposed to the network, and the
   page has no login, so do NOT bind it to a public address):
     PuTTY > Connection > SSH > Tunnels:  Source port 4173, Destination 127.0.0.1:4173, Add, then Open the session
   (or from a Windows terminal:  ssh -L 4173:127.0.0.1:4173 USER@SERVER_IP)
   Then browse to  http://localhost:4173/  on your PC.
   To open it by the server IP instead (trusted network only, no login):  HOST=0.0.0.0 ./start.sh  then  http://SERVER_IP:4173/

5. SRT:
   - Caller mode (PlayProbe connects out to a source): nothing to open on the server.
   - Listener mode (an encoder pushes to the server): open the port on the server's firewall, as UDP:
       sudo ufw allow 9101/udp
     and point the encoder at srt://SERVER_IP:9101 (mode caller). Cloud servers also need the port
     opened in their security group.

6. Check the load while channels run:
     ./load-report.sh 5
   (the SRT panel in the web page also shows machine / server / ffmpeg load live), or  htop .

Files: logs/<date>/ (daily logs) and .playprobe/ (settings, may contain the Slack webhook) are created in this folder.
Set the Slack webhook once in the Alerts tab, or start with  SRT_WEBHOOK_URL=... ./start.sh
Environment: PORT (default 4173), HOST (default 127.0.0.1).
