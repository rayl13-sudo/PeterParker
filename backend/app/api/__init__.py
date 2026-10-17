from fastapi import APIRouter

from app.api.routes import auth, health, items, navigation, parking, reviews

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(items.router)
api_router.include_router(parking.router)
api_router.include_router(navigation.router)
api_router.include_router(reviews.router)
