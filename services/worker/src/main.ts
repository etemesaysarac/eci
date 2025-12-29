import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import Redis from "ioredis";

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const redis = new Redis(redisUrl);

  try {
    const pong = await redis.ping();
    console.log(`[worker] started. redis ping => ${pong}`);
  } catch (e) {
    console.error("[worker] redis connection failed", e);
  } finally {
    redis.disconnect();
  }
}

bootstrap();
