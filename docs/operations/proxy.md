# 域名与反向代理

## 站点域名与图片域名

- `PUBLIC_ORIGIN`：站点来源，例如 `https://pic.example.com`，不含路径和末尾斜杠。
- 图片域名：可在设置中单独配置，例如 `https://img.example.com`；留空跟随站点域名。
- 都未设置时，浏览器请求生成的链接使用当前请求来源；后台没有浏览器请求，因此需要绝对链接的通知应配置域名。

两个域名都需要指向实际提供 Picloom 服务的入口。只填写图片域名不会自动配置 DNS、证书或反向代理。

## Nginx 示例

以下片段放入**已有证书的 HTTPS server 块**。示例允许 64 MiB 请求，适合默认上传与分片大小；修改应用限制后，也要同步评估代理限制。

```nginx
client_max_body_size 64m;

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 180s;
}
```

设置 `PUBLIC_ORIGIN` 为 HTTPS 来源，使会话 Cookie 使用 HTTPS 策略。

## 真实 IP

`TRUSTED_PROXIES` 填写 Picloom 实际看到的代理 IP，逗号分隔。代理必须**覆盖**客户端传入的 `X-Real-IP`。

Docker 网络中代理地址未必是 `127.0.0.1`，应按实际网络配置填写。该设置影响游客每日额度等基于客户端 IP 的行为。

## 防盗链与缓存

防盗链可以允许精确域名或 `*.example.com` 子域名，并决定是否允许无 Referer 的访问。它不是登录校验。

图片响应缓存时间控制浏览器/CDN 的新鲜期；设置较长时间后，即使站内删除图片，客户端也可能暂时继续展示旧缓存。签名跳转的缓存时间还会受链接有效期约束。
