# 使用一个轻量级的Nginx镜像作为基础镜像
FROM nginx:alpine-slim

# 设置工作目录
WORKDIR /usr/share/nginx/html

# 删除自带的默认文件
RUN rm -rf ./*

# 复制项目文件到镜像中
COPY index.html style.css ./

# 暴露端口
EXPOSE 80

# 启动Nginx
CMD ["nginx", "-g", "daemon off;"]
