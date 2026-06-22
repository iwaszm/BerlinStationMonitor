# Android 手机作为 Kindle 局域网代理

这套方案让 Kindle 只访问局域网 HTTP 页面：

```text
Kindle -> http://Android手机IP:3000/kindle -> Android/Termux Node server -> BVG/VBB API
```

这样 Kindle 第八代的老浏览器不需要直接处理公网 HTTPS、DNS 和 TLS 恢复，网络稳定性通常比直接打开公网域名更好。

## 前提

- Android 7 或更新版本。
- Android 手机和 Kindle 连接同一个 FRITZ!Box 局域网。
- Android 手机长期接电，或至少关闭对 Termux 的后台限制。
- FRITZ!Box 给 Android 手机固定 IP，例如 `192.168.178.40`。
- 不需要 FRITZ!Box 端口转发；只在家里局域网访问。

## 安装 Termux

从 F-Droid 安装：

- Termux
- Termux:Boot

不要使用旧的 Google Play 版 Termux。

Android 系统设置里建议：

- 关闭 Termux 和 Termux:Boot 的电池优化。
- 允许后台运行。
- 保持 Wi-Fi 连接。

## 部署项目

打开 Termux：

```sh
pkg update
pkg install nodejs git
cd ~
git clone https://github.com/iwaszm/BerlinStationMonitor.git
cd BerlinStationMonitor
npm run check
PORT=3000 npm start
```

在 Android 手机浏览器里测试：

```text
http://127.0.0.1:3000/kindle
```

在 Kindle 上测试：

```text
http://192.168.178.40:3000/kindle
```

把 `192.168.178.40` 换成 FRITZ!Box 分配给 Android 手机的固定 IP。

## 开机自启

先手动打开一次 Termux:Boot App，让它获得启动权限。

在 Termux 里创建启动目录：

```sh
mkdir -p ~/.termux/boot
```

把本仓库里的启动脚本复制进去：

```sh
cp ~/BerlinStationMonitor/tools/termux-boot-berlin-monitor ~/.termux/boot/berlin-monitor
chmod +x ~/.termux/boot/berlin-monitor
```

重启 Android 手机后，用 Kindle 打开：

```text
http://192.168.178.40:3000/kindle
```

## 维护

更新代码：

```sh
cd ~/BerlinStationMonitor
git pull
npm run check
```

重启服务：

```sh
pkill -f "node server.js"
PORT=3000 npm start
```

查看日志：

```sh
tail -f ~/berlin-monitor.log
```

如果开机后服务没有起来，打开 Termux 手动运行：

```sh
cd ~/BerlinStationMonitor
PORT=3000 npm start
```

## FRITZ!Box 设置

在 FRITZ!Box 7530 中：

1. 打开 `Heimnetz`。
2. 进入 `Netzwerk`。
3. 找到 Android 手机。
4. 勾选让该设备始终获得同一个 IPv4 地址。
5. 记下该地址，给 Kindle 使用。

## 省电建议

- Android 手机接电运行最稳。
- Termux:Boot 脚本会执行 `termux-wake-lock`，避免 Android 睡眠导致服务停掉。
- Kindle 页面继续使用 60 秒自动刷新，不建议提高刷新频率。
- Kindle 只访问局域网 HTTP，通常比直接访问公网 HTTPS 更省电、更稳定。
- 如果 Android 手机仍杀后台，继续检查厂商电池管理，给 Termux 加入白名单。

## 常见问题

### Kindle 打不开 `http://手机IP:3000/kindle`

- 确认 Android 手机和 Kindle 在同一个 Wi-Fi。
- 确认 Termux 里 `PORT=3000 npm start` 还在运行。
- 在 Android 手机浏览器先打开 `http://127.0.0.1:3000/kindle`。
- 检查 FRITZ!Box 是否把 Android 手机 IP 改了。

### Kindle 能打开页面但没有数据

- Android 手机需要能访问公网。
- 在 Termux 里看日志：

```sh
tail -f ~/berlin-monitor.log
```

### 重启后服务没起来

- 确认装的是 Termux:Boot，并且手动打开过一次。
- 确认脚本有执行权限：

```sh
ls -l ~/.termux/boot/berlin-monitor
```

- 确认 Android 没有限制 Termux 后台启动。
