#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <vector>
#include <algorithm>
#include <queue>
#include "dts_loader.h"

// ============================================================
// Starsiege: Tribes — Browser Edition
// Full game: 3 armors, 9 weapons, skiing, jetpack, CTF, bots
// All values from original source code
//
// Build command (Emscripten):
//   emcc wasm_main.cpp -o tribes.html --preload-file assets@/assets \
//        -s USE_WEBGL2=1 -s FULL_ES3=1 -s ALLOW_MEMORY_GROWTH=1 \
//        -O2 -std=c++17
// The --preload-file flag bundles DTS models into the WASM
// virtual filesystem so loadDTS() can open them via fopen().
// ============================================================

static const int CANVAS_W = 1024;
static const int CANVAS_H = 768;
static const float PI = 3.14159265f;
static const float DEG2RAD = PI / 180.0f;
static const float TICK = 0.032f; // 32ms tick like original

// ============================================================
// Vec3
// ============================================================
struct Vec3 {
    float x,y,z;
    Vec3():x(0),y(0),z(0){}
    Vec3(float x,float y,float z):x(x),y(y),z(z){}
    Vec3 operator+(const Vec3&v)const{return{x+v.x,y+v.y,z+v.z};}
    Vec3 operator-(const Vec3&v)const{return{x-v.x,y-v.y,z-v.z};}
    Vec3 operator*(float s)const{return{x*s,y*s,z*s};}
    Vec3&operator+=(const Vec3&v){x+=v.x;y+=v.y;z+=v.z;return*this;}
    Vec3&operator-=(const Vec3&v){x-=v.x;y-=v.y;z-=v.z;return*this;}
    float dot(const Vec3&v)const{return x*v.x+y*v.y+z*v.z;}
    Vec3 cross(const Vec3&v)const{return{y*v.z-z*v.y,z*v.x-x*v.z,x*v.y-y*v.x};}
    float len()const{return sqrtf(x*x+y*y+z*z);}
    float lenSq()const{return x*x+y*y+z*z;}
    Vec3 normalized()const{float l=len();return l>0.0001f?Vec3{x/l,y/l,z/l}:Vec3{0,0,0};}
};

struct Mat4 {
    float m[16];
    static Mat4 identity(){Mat4 r;memset(r.m,0,64);r.m[0]=r.m[5]=r.m[10]=r.m[15]=1;return r;}
    static Mat4 perspective(float fov,float asp,float n,float f){
        Mat4 r;memset(r.m,0,64);float t=1.0f/tanf(fov*0.5f);
        r.m[0]=t/asp;r.m[5]=t;r.m[10]=(f+n)/(n-f);r.m[11]=-1;r.m[14]=2*f*n/(n-f);return r;}
    static Mat4 lookAt(Vec3 eye,Vec3 fwd,Vec3 up){
        Vec3 f=fwd.normalized(),r=f.cross(up).normalized(),u=r.cross(f);
        Mat4 m=identity();
        m.m[0]=r.x;m.m[4]=r.y;m.m[8]=r.z;
        m.m[1]=u.x;m.m[5]=u.y;m.m[9]=u.z;
        m.m[2]=-f.x;m.m[6]=-f.y;m.m[10]=-f.z;
        m.m[12]=-(r.dot(eye));m.m[13]=-(u.dot(eye));m.m[14]=f.dot(eye);return m;}
    static Mat4 translate(float tx,float ty,float tz){
        Mat4 r=identity();r.m[12]=tx;r.m[13]=ty;r.m[14]=tz;return r;}
    static Mat4 rotateY(float angle){
        Mat4 r=identity();float c=cosf(angle),s=sinf(angle);
        r.m[0]=c;r.m[8]=s;r.m[2]=-s;r.m[10]=c;return r;}
    static Mat4 scale(float sx,float sy,float sz){
        Mat4 r=identity();r.m[0]=sx;r.m[5]=sy;r.m[10]=sz;return r;}
    Mat4 operator*(const Mat4&b)const{
        Mat4 r;memset(r.m,0,64);
        for(int i=0;i<4;i++)for(int j=0;j<4;j++)for(int k=0;k<4;k++)
            r.m[j*4+i]+=m[k*4+i]*b.m[j*4+k];return r;}
};

// ============================================================
// Terrain — Real Raindance heightmap from Tribes 1
// ============================================================
#include "raindance_heightmap.h"
#include "raindance_mission.h"

// ============================================================
// Runtime settings (overridden by JS via setSettings)
// ============================================================
static float g_mouseSensitivity=1.0f;
static float g_fov=90.0f;
static float g_renderDistMul=1.0f;
static bool  g_jetToggle=false;
static bool  g_invertY=false;
static bool  g_jetActive=false; // for toggle mode state

static double sGetF(const char*j,const char*k,double d){
    char s[64];snprintf(s,sizeof(s),"\"%s\":",k);
    const char*p=strstr(j,s);if(!p)return d;
    p+=strlen(s);while(*p==' ')p++;
    if(*p=='"'||*p=='{'||*p=='[')return d;
    return strtod(p,nullptr);
}
static bool sGetB(const char*j,const char*k,bool d){
    char s[64];snprintf(s,sizeof(s),"\"%s\":",k);
    const char*p=strstr(j,s);if(!p)return d;
    p+=strlen(s);while(*p==' ')p++;
    if(strncmp(p,"true",4)==0)return true;
    if(strncmp(p,"false",5)==0)return false;
    return d;
}
extern "C" void setSettings(const char*json){
    g_mouseSensitivity=(float)sGetF(json,"sensitivity",1.0);
    g_fov=(float)sGetF(json,"fov",90.0);
    g_renderDistMul=(float)sGetF(json,"renderDist",1.0);
    g_jetToggle=sGetB(json,"jetToggle",false);
    g_invertY=sGetB(json,"invertY",false);
}

static const int TSIZE=RAINDANCE_SIZE; // 257
static const float TSCALE=8.0f; // 8 meters per terrain cell (Tribes default)
static const float THEIGHT=RAINDANCE_HEIGHT_MAX;
// Map origin: the heightmap grid (0,0) maps to world (0,0).
// Mission coords are in Tribes world space. Flags at roughly (-220,22) and (-379,641).
// We center the map: world X = (gridX - 128) * 8, world Z = (gridZ - 128) * 8

static void genTerrain(){
    // Raindance heightmap is loaded from the header at compile time — nothing to do
    printf("[Terrain] Raindance heightmap loaded: %dx%d, height range %.1f to %.1f\n",
           RAINDANCE_SIZE, RAINDANCE_SIZE, RAINDANCE_HEIGHT_MIN, RAINDANCE_HEIGHT_MAX);
}

static float getH(float wx,float wz){
    // Convert world coords to grid coords
    // World (0,0) = grid center (128,128)
    float tx=wx/TSCALE+TSIZE*0.5f;
    float tz=wz/TSCALE+TSIZE*0.5f;
    int ix=(int)floorf(tx),iz=(int)floorf(tz);
    if(ix<0) ix=0; if(ix>=TSIZE-1) ix=TSIZE-2;
    if(iz<0) iz=0; if(iz>=TSIZE-1) iz=TSIZE-2;
    float fx=tx-ix,fz=tz-iz;
    if(fx<0)fx=0; if(fx>1)fx=1;
    if(fz<0)fz=0; if(fz>1)fz=1;
    return RAINDANCE_HEIGHTS[iz][ix]*(1-fx)*(1-fz)+RAINDANCE_HEIGHTS[iz][ix+1]*fx*(1-fz)+
           RAINDANCE_HEIGHTS[iz+1][ix]*(1-fx)*fz+RAINDANCE_HEIGHTS[iz+1][ix+1]*fx*fz;
}

static Vec3 getNorm(float wx,float wz){
    float d=TSCALE;
    return Vec3(getH(wx-d,wz)-getH(wx+d,wz),2*d,getH(wx,wz-d)-getH(wx,wz+d)).normalized();
}

static GLuint tVAO,tVBO,tEBO;
static int tIdxCount=0;
static void buildTerrain(){
    struct V{float x,y,z,nx,ny,nz,r,g,b;};
    int n=TSIZE;V*verts=new V[n*n];
    // Tribes 1 terrain palette (from visual spec §2):
    // Olive-green grass #7A8A55 to dry tan dirt #A89060
    // Rock on steep slopes, snow only at extreme height
    float hMin=RAINDANCE_HEIGHT_MIN, hMax=RAINDANCE_HEIGHT_MAX, hRange=hMax-hMin;
    for(int z=0;z<n;z++)for(int x=0;x<n;x++){
        float wx=(x-n*0.5f)*TSCALE,wz=(z-n*0.5f)*TSCALE;
        float h=RAINDANCE_HEIGHTS[z][x];
        Vec3 nm=getNorm(wx,wz);
        float t=(h-hMin)/hRange; // 0=low, 1=high
        float slope=1.0f-nm.y;   // 0=flat, 1=cliff

        // Base color: blend from olive-green (low) to tan-brown (high)
        // Olive green: (0.48, 0.54, 0.33)  Tan dirt: (0.66, 0.56, 0.38)
        float r = 0.48f + t*0.18f;
        float g = 0.54f - t*0.02f;
        float b = 0.33f + t*0.05f;

        // Steep slopes: grey-brown rock
        if(slope>0.4f){
            float rockBlend=fminf((slope-0.4f)/0.3f, 1.0f);
            r=r*(1-rockBlend)+0.42f*rockBlend;
            g=g*(1-rockBlend)+0.38f*rockBlend;
            b=b*(1-rockBlend)+0.32f*rockBlend;
        }
        // High altitude: lighter, drier
        if(t>0.7f){
            float dryBlend=(t-0.7f)/0.3f;
            r+=dryBlend*0.1f;
            g+=dryBlend*0.05f;
            b+=dryBlend*0.02f;
        }
        // Low valleys: slightly darker, more green
        if(t<0.2f){
            float valBlend=(0.2f-t)/0.2f;
            r-=valBlend*0.05f;
            g+=valBlend*0.03f;
            b-=valBlend*0.02f;
        }

        verts[z*n+x]={wx,h,wz,nm.x,nm.y,nm.z,r,g,b};
    }
    unsigned*idx=new unsigned[(n-1)*(n-1)*6];int ic=0;
    for(int z=0;z<n-1;z++)for(int x=0;x<n-1;x++){
        unsigned tl=z*n+x,tr=tl+1,bl=(z+1)*n+x,br=bl+1;
        idx[ic++]=tl;idx[ic++]=bl;idx[ic++]=tr;idx[ic++]=tr;idx[ic++]=bl;idx[ic++]=br;
    }
    tIdxCount=ic;
    glGenVertexArrays(1,&tVAO);glGenBuffers(1,&tVBO);glGenBuffers(1,&tEBO);
    glBindVertexArray(tVAO);
    glBindBuffer(GL_ARRAY_BUFFER,tVBO);glBufferData(GL_ARRAY_BUFFER,n*n*sizeof(V),verts,GL_STATIC_DRAW);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER,tEBO);glBufferData(GL_ELEMENT_ARRAY_BUFFER,ic*4,idx,GL_STATIC_DRAW);
    glVertexAttribPointer(0,3,GL_FLOAT,0,sizeof(V),(void*)0);glEnableVertexAttribArray(0);
    glVertexAttribPointer(1,3,GL_FLOAT,0,sizeof(V),(void*)12);glEnableVertexAttribArray(1);
    glVertexAttribPointer(2,3,GL_FLOAT,0,sizeof(V),(void*)24);glEnableVertexAttribArray(2);
    delete[]verts;delete[]idx;
    printf("[Terrain] Built mesh: %d triangles\n", ic/3);
}

// ============================================================
// Armor types (from ArmorData.cs)
// ============================================================
enum ArmorType { ARMOR_LIGHT=0, ARMOR_MEDIUM, ARMOR_HEAVY, ARMOR_COUNT };
struct ArmorData {
    const char*name;
    float maxDamage,maxEnergy,maxFwdSpeed,maxBackSpeed,maxSideSpeed;
    float mass,density,drag,groundForce,groundTraction;
    float jumpImpulse,jetForce,jetEnergyDrain,maxJetFwdVel,maxJetSideForce;
    float minJetEnergy;
    int maxWeapons;
    float hitW,hitD,hitH;
    bool canCrouch;
    float damageScale;
    int maxBullet,maxPlasma,maxDisc,maxGrenadeAmmo,maxMortarAmmo;
    int maxHandGrenade,maxMine;
    float energyRegenMul; // F7: per-armor energy regen multiplier (Light=1.0, Med=0.85, Heavy=0.6)
};
static const ArmorData armors[3]={
    {"Light",  0.66f,60, 11,10,10, 9,1.2f,1, 360,3, 75, 236,0.8f,22,0.8f, 1, 3, 0.5f,0.5f,2.3f, true, 0.005f, 100,30,15,10,10,5,3, 1.0f},
    {"Medium", 1.0f, 80, 8, 7, 7, 13,1.5f,1, 455,3, 110,320,1.0f,17,0.8f, 1, 4, 0.7f,0.7f,2.4f, false,0.005f, 150,40,15,10,10,6,3, 0.85f},
    {"Heavy",  1.32f,110,5, 4, 4, 18,2.5f,1, 630,4.5f,150,385,1.1f,12,0.8f, 1, 5, 0.8f,0.8f,2.6f, false,0.006f, 200,50,15,15,10,8,3, 0.6f},
};

// ============================================================
// Weapons (from baseProjData.cs + item.cs)
// ============================================================
enum WeaponType {
    WPN_BLASTER=0, WPN_CHAINGUN, WPN_DISC, WPN_GRENADE_LAUNCHER,
    WPN_PLASMA, WPN_MORTAR, WPN_LASER, WPN_ELF, WPN_REPAIR, WPN_COUNT
};
struct WeaponData {
    const char*name;
    float damage,fireTime,reloadTime,muzzleVel;
    float explosionRadius,kickback;
    float gravity; // projectile gravity
    bool usesAmmo;
    float energyCost;
    float projLife;
    float r,g,b; // projectile color
    float inheritScale; // F6: fraction of player velocity added to projectile (0=none, 1=full)
};
static const WeaponData weapons[WPN_COUNT]={
    // name         dmg   fire  rld   muz    expl kick  grav  ammo  enrg  life  r     g     b     inh
    {"Blaster",     0.125f,0.3f, 0,   200, 0,  0,   5,   false,5,  1.5f, 1.0f,0.8f,0.2f, 0.0f},
    {"Chaingun",    0.11f, 0.1f, 0,   425, 0,  0,   0,   true, 0,  1.5f, 1.0f,1.0f,0.3f, 0.0f},
    {"Disc",        0.5f,  1.25f,0.25f,65, 7.5f,150, 5,   true, 0,  6.5f, 1.0f,1.0f,1.0f, 0.5f},
    {"Grenade L.",  0.4f,  0.5f, 0.5f, 40, 15,  150, 25,  true, 0,  4.0f, 0.4f,0.8f,0.2f, 0.5f},
    {"Plasma",      0.45f, 0.5f, 0.1f, 55, 4,   0,   3,   true, 0,  2.0f, 0.2f,1.0f,0.2f, 0.3f},
    {"Mortar",      1.0f,  2.0f, 0.5f, 50, 20,  250, 20,  true, 0,  8.0f, 1.0f,0.5f,0.1f, 1.0f},
    {"Laser",       0.42f, 0.5f, 0.1f, 9999,0,  0,   0,   false,60, 0,    1.0f,0.2f,0.2f, 0.0f},
    {"ELF Gun",     0.06f, 0.1f, 0.2f, 0,   0,  0,   0,   false,5,  0,    0.5f,0.5f,1.0f, 0.0f},
    {"Repair",      -0.05f,0.1f, 0,    0,   0,  0,   0,   false,3,  0,    0.2f,1.0f,0.5f, 0.0f},
};
static const bool armorCanUse[3][WPN_COUNT]={
    {1,1,1,1,1,0,1,1,1}, // Light: no mortar
    {1,1,1,1,1,0,0,1,1}, // Medium: no mortar, no laser
    {1,1,1,1,1,1,0,1,1}, // Heavy: no laser
};

// ============================================================
// Projectiles
// ============================================================
static const int MAX_PROJ=128;
struct Projectile {
    Vec3 pos,vel;
    float life;
    int weapon;
    int ownerTeam;
    bool active;
};
static Projectile projs[MAX_PROJ];

// ============================================================
// Particles
// ============================================================
static const int MAX_PART=1024;
struct Particle {
    Vec3 pos,vel;
    float life,maxLife,r,g,b,size;
    bool active;
};
static Particle parts[MAX_PART];
static void spawnPart(Vec3 p,Vec3 v,float r,float g,float b,float life,float size=0.15f){
    for(int i=0;i<MAX_PART;i++)if(!parts[i].active){
        parts[i]={p,v,life,life,r,g,b,size,true};return;}
}
static void spawnBurst(Vec3 p,int n,float spread,float speed,float r,float g,float b,float life){
    for(int i=0;i<n;i++){
        float rx=((rand()%1000)/500.0f-1)*spread;
        float ry=((rand()%1000)/500.0f)*spread;
        float rz=((rand()%1000)/500.0f-1)*spread;
        spawnPart(p,Vec3(rx,ry+0.5f,rz)*speed,r,g,b,life*(0.5f+(rand()%1000)/1000.0f));
    }
}

// ============================================================
// Flags (CTF from objectives.cs)
// ============================================================
struct Flag {
    Vec3 homePos,pos;
    int team; // 0=red, 1=blue
    bool atHome,carried;
    int carrierIdx; // -1 = none
    float dropTimer; // 45s auto-return
    float fadeTimer;
};
static Flag flags[2];
static int teamScore[2]={0,0};
static int g_scoreLimit=5;
static int g_timeLimit=600; // 0 = unlimited
static float g_roundTimer=600.0f;
static float g_warmupTimer=15.0f;
static int g_matchState=0; // 0=WARMUP,1=IN_PROGRESS,2=MATCH_END
static float g_spawnProtect[8]={}; // [MAX_PLAYERS]
static float g_localRespawnTimer=0; // seconds until local player respawns (for HUD)
static bool g_warnedTime[3]={}; // [0]=4min, [1]=1min, [2]=warmup countdown sounds
static const float FLAG_RETURN_TIME=45.0f;

// ============================================================
// Nav grid (64×64, 32m cells) — built once at init from building AABBs
// ============================================================
static const int NAV_SIZE=64;
static const float NAV_CELL=32.0f;
static bool g_navWalkable[NAV_SIZE][NAV_SIZE];

// A* scratch buffers (global to avoid ~130KB of stack per call)
static int  s_gCost[NAV_SIZE][NAV_SIZE];
static bool s_closed[NAV_SIZE][NAV_SIZE];
static int  s_parent[NAV_SIZE*NAV_SIZE]; // index = i*NAV_SIZE+j, -1 = none

// Per-bot path state (outside Player to avoid memset corruption of std::vector)
static std::vector<Vec3> g_botPath[8]; // [MAX_PLAYERS]
static int   g_botPathIdx[8]={};
static float g_botPathTimer[8]={};
static Vec3  g_botLastPos[8]={};
static float g_botStuckAccum[8]={};
static float g_botFlagEventTimer[8]={}; // cooldown for [EVENT] flag pickup message

// ============================================================
// Players (human + bots)
// ============================================================
static const int MAX_PLAYERS=8;
struct Player {
    Vec3 pos,vel;
    float yaw,pitch;
    float health,energy;
    ArmorType armor;
    int team; // 0=red, 1=blue
    int curWeapon;
    float fireCooldown;
    bool onGround,jetting,skiing;
    float airSkiTimer;  // F2: seconds of ski-like physics to grant after leaving ground
    float traction;
    int jumpContact;
    float speed;
    int score,kills,deaths;
    bool alive,isBot;
    int ammo[WPN_COUNT];
    int carryingFlag; // -1 = none
    int pack; // 0=none, 1=energy, 2=repair, 3=ammo
    float healTimer;
    // Bot AI
    Vec3 botTarget;
    float botThinkTimer;
    int botState; // 0=goto flag, 1=return flag, 2=attack, 3=defend
    int botRole;  // 0=OFFENSE, 1=DEFENSE, 2=MIDFIELD
    bool active;
    char name[32];
};
static Player players[MAX_PLAYERS];
static int localPlayer=0;

// ============================================================
// Buildings — AABB collision volumes from Raindance mission data
// ============================================================
struct Building {
    Vec3 pos;
    Vec3 halfSize;
    float r, g, b;
    bool isRock;
};

static const int MAX_BUILDINGS = 256;   // R32.1.2: was 64; 46 base + 32 interior-shape AABBs + ~12 R32.3 static_shapes ≈ 90; 256 gives headroom. 256×36B=9KB, negligible.
static Building buildings[MAX_BUILDINGS];
static int numBuildings = 0;

static void addBuilding(float wx, float wy, float wz, float hx, float hy, float hz,
                         float r, float g, float b, bool isRock = false) {
    if (numBuildings >= MAX_BUILDINGS) return;
    buildings[numBuildings++] = {{wx, wy, wz}, {hx, hy, hz}, r, g, b, isRock};
}

static void initBuildings() {
    numBuildings = 0;
    // R32.1.3: interior-shape loop REMOVED. The per-name guess halfExtents (iobservation
    // at 4×6×4 m around a 1×1×6 m mesh, etc.) created a massive "invisible force field"
    // around every building because both the legacy guess AABBs AND the real mesh-bound
    // AABBs from appendInteriorShapeAABBs() (R32.1) were in buildings[]. Minkowski-sum
    // collision always picked the larger (wrongly-sized) one. Now appendInteriorShapeAABBs()
    // from renderer.js is the sole source of interior-shape collision using actual .dis bounds.
    // Generators / turrets / stations keep their own small fixed-size AABBs below.

    for (int i = 0; i < RAINDANCE_GENERATOR_COUNT; i++) {
        float wx = RAINDANCE_GENERATORS[i].x;
        float wz = -RAINDANCE_GENERATORS[i].y;
        float wy = RAINDANCE_GENERATORS[i].z;
        addBuilding(wx, wy, wz, 1.5f, 2.0f, 1.5f, 0.45f, 0.40f, 0.30f);
    }

    for (int i = 0; i < RAINDANCE_TURRET_COUNT; i++) {
        float wx = RAINDANCE_TURRETS[i].x;
        float wz = -RAINDANCE_TURRETS[i].y;
        float wy = RAINDANCE_TURRETS[i].z;
        addBuilding(wx, wy, wz, 1.0f, 2.5f, 1.0f, 0.50f, 0.45f, 0.35f);
    }

    for (int i = 0; i < RAINDANCE_STATION_COUNT; i++) {
        float wx = RAINDANCE_STATIONS[i].x;
        float wz = -RAINDANCE_STATIONS[i].y;
        float wy = RAINDANCE_STATIONS[i].z;
        addBuilding(wx, wy, wz, 1.0f, 1.5f, 1.0f, 0.30f, 0.40f, 0.35f);
    }

    printf("[Buildings] Initialized %d collision volumes from mission data\n", numBuildings);
}

static bool resolvePlayerBuildingCollision(Vec3& pos, Vec3& vel, float playerRadius, float playerHeight) {
    bool hit = false;
    for (int i = 0; i < numBuildings; i++) {
        if (buildings[i].isRock) continue;
        const Building& bld = buildings[i];
        float px = bld.halfSize.x + playerRadius;
        float py = bld.halfSize.y;
        float pz = bld.halfSize.z + playerRadius;
        float dx = pos.x - bld.pos.x;
        float dy = pos.y - bld.pos.y;
        float dz = pos.z - bld.pos.z;

        if (fabsf(dx) < px && dy > -py && dy < py + playerHeight && fabsf(dz) < pz) {
            float exitX = px - fabsf(dx);
            float exitZ = pz - fabsf(dz);
            float exitYTop = py + playerHeight - dy;
            float exitYBottom = dy + py;

            float minExit = exitX;
            int axis = 0;
            if (exitZ < minExit) { minExit = exitZ; axis = 2; }
            if (exitYTop < minExit) { minExit = exitYTop; axis = 3; }
            if (exitYBottom < minExit && exitYBottom > 0) { minExit = exitYBottom; axis = 1; }

            switch (axis) {
                case 0: pos.x = bld.pos.x + (dx > 0 ? px : -px); vel.x = 0; break;
                case 1: pos.y = bld.pos.y + py; if (vel.y < 0) vel.y = 0; break;
                case 2: pos.z = bld.pos.z + (dz > 0 ? pz : -pz); vel.z = 0; break;
                case 3: pos.y = bld.pos.y - py - playerHeight; if (vel.y > 0) vel.y = 0; break;
            }
            hit = true;
        }
    }
    return hit;
}

static bool projectileHitsInterior(Vec3 pos); // forward declaration
static bool projectileHitsBuilding(Vec3 pos) {
    for (int i = 0; i < numBuildings; i++) {
        const Building& bld = buildings[i];
        if (bld.isRock) continue;
        if (fabsf(pos.x - bld.pos.x) < bld.halfSize.x &&
            pos.y > bld.pos.y - bld.halfSize.y &&
            pos.y < bld.pos.y + bld.halfSize.y &&
            fabsf(pos.z - bld.pos.z) < bld.halfSize.z) {
            return true;
        }
    }
    return projectileHitsInterior(pos);
}

// ============================================================
// R32.68: Per-triangle interior mesh collision
// Replaces whole-building AABB collision with actual mesh geometry.
// Fixes "force field" / teleportation and enables building entry.
// ============================================================
static const int MAX_COL_TRIS   = 16384;
static const int MAX_COL_MESHES = 64;

struct ColTri {
    Vec3 v0, v1, v2;
    Vec3 normal;
};

struct ColMesh {
    Vec3 aabbMin, aabbMax;  // world-space bounding box for broadphase
    int  triStart, triCount;
};

static ColTri  g_colTris[MAX_COL_TRIS];
static int     g_numColTris = 0;
static ColMesh g_colMeshes[MAX_COL_MESHES];
static int     g_numColMeshes = 0;

// --- Vector helpers (inline, used by collision) ---
static inline Vec3 v3cross(Vec3 a, Vec3 b) {
    return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
static inline float v3dot(Vec3 a, Vec3 b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
static inline float v3lenSq(Vec3 a) { return a.x*a.x + a.y*a.y + a.z*a.z; }
static inline Vec3  v3sub(Vec3 a, Vec3 b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
static inline Vec3  v3add(Vec3 a, Vec3 b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
static inline Vec3  v3scale(Vec3 a, float s) { return {a.x*s, a.y*s, a.z*s}; }

// Closest point on line segment AB to point P
static Vec3 closestPointOnSegment(Vec3 p, Vec3 a, Vec3 b) {
    Vec3 ab = v3sub(b, a);
    float t = v3dot(v3sub(p, a), ab);
    float denom = v3dot(ab, ab);
    if (denom < 1e-10f) return a;
    t /= denom;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return v3add(a, v3scale(ab, t));
}

// Closest point on triangle to point P
static Vec3 closestPointOnTriangle(Vec3 p, Vec3 v0, Vec3 v1, Vec3 v2) {
    Vec3 e0 = v3sub(v1, v0), e1 = v3sub(v2, v0), v = v3sub(p, v0);
    float d00 = v3dot(e0, e0), d01 = v3dot(e0, e1), d11 = v3dot(e1, e1);
    float d20 = v3dot(v, e0),  d21 = v3dot(v, e1);
    float denom = d00*d11 - d01*d01;
    if (fabsf(denom) < 1e-10f) return v0; // degenerate
    float invD = 1.0f / denom;
    float s = (d11*d20 - d01*d21) * invD;
    float t = (d00*d21 - d01*d20) * invD;
    if (s >= 0 && t >= 0 && s + t <= 1) {
        return v3add(v0, v3add(v3scale(e0, s), v3scale(e1, t))); // inside triangle
    }
    // Closest point on edges
    Vec3 c0 = closestPointOnSegment(p, v0, v1);
    Vec3 c1 = closestPointOnSegment(p, v1, v2);
    Vec3 c2 = closestPointOnSegment(p, v2, v0);
    float d0 = v3lenSq(v3sub(p, c0));
    float d1 = v3lenSq(v3sub(p, c1));
    float d2 = v3lenSq(v3sub(p, c2));
    if (d0 <= d1 && d0 <= d2) return c0;
    if (d1 <= d2) return c1;
    return c2;
}

// Sphere vs triangle collision. Returns push direction and depth if colliding.
static bool sphereVsTriangle(Vec3 center, float radius, const ColTri& tri,
                              Vec3& pushDir, float& pushDepth) {
    Vec3 closest = closestPointOnTriangle(center, tri.v0, tri.v1, tri.v2);
    Vec3 diff = v3sub(center, closest);
    float distSq = v3lenSq(diff);
    if (distSq > radius*radius || distSq < 1e-10f) return false;
    float dist = sqrtf(distSq);
    pushDir = v3scale(diff, 1.0f / dist);
    pushDepth = radius - dist;
    return true;
}

// Resolve player collision against all interior mesh triangles.
// Player model: vertical capsule = two spheres (bottom + top) connected.
//   pos.y = feet. Player occupies [pos.y, pos.y + playerHeight].
//   Lower sphere center: (pos.x, pos.y + radius, pos.z)
//   Upper sphere center: (pos.x, pos.y + playerHeight - radius, pos.z)
// R32.100: Floor surfaces treated like terrain (snap Y, preserve horizontal vel).
// Returns true if any collision was resolved.
static bool resolvePlayerInteriorCollision(Vec3& pos, Vec3& vel,
                                            float playerRadius, float playerHeight) {
    if (g_numColMeshes == 0) return false;
    bool anyHit = false;
    const float PAD = 0.5f; // broadphase padding

    // Iterate up to 6 times for convergence
    for (int iter = 0; iter < 6; iter++) {
        Vec3 loCenter = {pos.x, pos.y + playerRadius, pos.z};
        Vec3 hiCenter = {pos.x, pos.y + playerHeight - playerRadius, pos.z};
        if (hiCenter.y < loCenter.y) hiCenter.y = loCenter.y;

        // Accumulate all pushes this iteration, separated by type
        Vec3 floorPush = {0,0,0};   // mostly-upward pushes (floor)
        float floorDepth = 0;
        Vec3 wallPush = {0,0,0};    // lateral pushes (walls/ceiling)
        float wallDepth = 0;

        for (int mi = 0; mi < g_numColMeshes; mi++) {
            const ColMesh& m = g_colMeshes[mi];
            // Broadphase: player AABB vs mesh AABB
            if (pos.x + playerRadius + PAD < m.aabbMin.x || pos.x - playerRadius - PAD > m.aabbMax.x ||
                pos.y + playerHeight + PAD < m.aabbMin.y || pos.y - PAD > m.aabbMax.y ||
                pos.z + playerRadius + PAD < m.aabbMin.z || pos.z - playerRadius - PAD > m.aabbMax.z) continue;

            // Narrowphase: test each triangle
            for (int ti = m.triStart; ti < m.triStart + m.triCount; ti++) {
                const ColTri& tri = g_colTris[ti];
                Vec3 pushDir; float pushDepth;

                // Test lower sphere
                if (sphereVsTriangle(loCenter, playerRadius, tri, pushDir, pushDepth)) {
                    if (pushDir.y > 0.7f) {
                        // Floor surface — track deepest floor push
                        if (pushDepth > floorDepth) { floorDepth = pushDepth; floorPush = pushDir; }
                    } else {
                        // Wall/ceiling — track deepest wall push
                        if (pushDepth > wallDepth) { wallDepth = pushDepth; wallPush = pushDir; }
                    }
                }
                // Test upper sphere
                if (hiCenter.y != loCenter.y) {
                    if (sphereVsTriangle(hiCenter, playerRadius, tri, pushDir, pushDepth)) {
                        if (pushDir.y < -0.7f) {
                            // Ceiling — just zero upward vel, push down
                            if (pushDepth > wallDepth) { wallDepth = pushDepth; wallPush = pushDir; }
                        } else if (pushDir.y <= 0.7f) {
                            // Wall on upper body
                            if (pushDepth > wallDepth) { wallDepth = pushDepth; wallPush = pushDir; }
                        }
                    }
                }
            }
        }

        bool hitThisIter = false;

        // Resolve floor pushes — treat like terrain: snap Y, preserve horizontal
        if (floorDepth > 0.001f) {
            // Snap upward only — like terrain clamp
            pos.y += floorDepth + 0.002f;
            // Zero downward velocity only (same as terrain)
            if (vel.y < 0) vel.y = 0;
            hitThisIter = true;
        }

        // Resolve wall/ceiling pushes — slide velocity along surface
        if (wallDepth > 0.001f) {
            pos = v3add(pos, v3scale(wallPush, wallDepth + 0.002f));
            // Slide: remove velocity into the wall
            float velDot = v3dot(vel, wallPush);
            if (velDot < 0) {
                vel = v3sub(vel, v3scale(wallPush, velDot));
            }
            // Ceiling: zero upward vel
            if (wallPush.y < -0.5f && vel.y > 0) vel.y = 0;
            hitThisIter = true;
        }

        if (!hitThisIter) break;
        anyHit = true;
    }

    return anyHit;
}

// Also check projectile vs interior triangles (for explosions hitting buildings)
static bool projectileHitsInterior(Vec3 pos) {
    for (int mi = 0; mi < g_numColMeshes; mi++) {
        const ColMesh& m = g_colMeshes[mi];
        if (pos.x < m.aabbMin.x || pos.x > m.aabbMax.x ||
            pos.y < m.aabbMin.y || pos.y > m.aabbMax.y ||
            pos.z < m.aabbMin.z || pos.z > m.aabbMax.z) continue;
        for (int ti = m.triStart; ti < m.triStart + m.triCount; ti++) {
            const ColTri& tri = g_colTris[ti];
            Vec3 closest = closestPointOnTriangle(pos, tri.v0, tri.v1, tri.v2);
            if (v3lenSq(v3sub(pos, closest)) < 0.25f) return true; // within 0.5m
        }
    }
    return false;
}

// ============================================================
// Render-state export (R15: Three.js renderer)
// Flat structs in BSS, exported as Float32Array views to JS via HEAPF32.
// Sizes are deliberately power-of-2 friendly for cacheline alignment.
// ============================================================
struct RenderPlayer {        // 32 floats = 128 bytes
    float pos[3];            // [0..2]
    float rot[3];            // [3..5] euler XYZ ('YXZ' order in Three.js)
    float vel[3];            // [6..8]
    float health;            // [9]
    float energy;            // [10]
    float team;              // [11] 0=red, 1=blue, 2=spectator
    float armor;             // [12] 0=light, 1=medium, 2=heavy
    float alive;             // [13]
    float jetting;           // [14]
    float skiing;            // [15]
    float weaponIdx;         // [16] -1 = none
    float carryingFlag;      // [17] -1 = none, else team idx
    float visible;           // [18]
    float botRole;           // [19] -1=human, 0=OFF, 1=DEF, 2=MID
    float reserved[12];      // [20..31] padding to 128 bytes
};
struct RenderProjectile {    // 16 floats = 64 bytes
    float pos[3];
    float vel[3];
    float type;              // 0=disc, 1=chain, 2=plasma, 3=grenade, 4=blaster, 5=mortar
    float age;
    float team;
    float alive;
    float reserved[6];
};
struct RenderParticle {      // 8 floats = 32 bytes
    float pos[3];
    float vel[3];
    float type;              // 0=jet, 1=ski, 2=hit, 3=explosion, 4=spark, 5=trail
    float age;
};
struct RenderFlag {          // 8 floats = 32 bytes
    float pos[3];
    float team;
    float state;             // 0=at-base, 1=carried, 2=dropped
    float carrierIdx;        // -1 or player idx
    float reserved[2];
};
struct RenderBuilding {      // 16 floats = 64 bytes
    float pos[3];
    float halfExtents[3];
    float type;              // 0=interior, 1=tower, 2=generator, 3=turret, 4=station, 5=rock
    float team;              // -1=neutral, 0=red, 1=blue
    float alive;
    float color[3];          // RGB tint for placeholder rendering
    float reserved[3];
};

static RenderPlayer       g_rPlayers[16];
static RenderProjectile   g_rProjectiles[256];
static RenderParticle     g_rParticles[1024];
static RenderFlag         g_rFlags[2];
static RenderBuilding     g_rBuildings[64];
static int g_rPlayerCount = 0;
static int g_rProjectileCount = 0;
static int g_rParticleCount = 0;
static int g_rBuildingCount = 0;
static int g_localPlayerIdx = 0;
static int g_renderMode = 0;     // 0 = legacy WebGL, 1 = Three.js (skip C++ render)
static int g_renderReady = 0;    // 1 once init has populated buildings

// ============================================================
// Turrets & Generators
// ============================================================
struct Turret {
    Vec3 pos;
    int team;
    float hp, aimYaw, fireCooldown, scanTimer;
    int targetIdx;
    bool alive;
};
static Turret turrets[RAINDANCE_TURRET_COUNT];

struct Generator {
    Vec3 pos;
    int team;
    float hp, sparkTimer;
    bool alive;
};
static Generator generators[RAINDANCE_GENERATOR_COUNT];
static bool generatorAlive[2]={true,true};

// ============================================================
// Shaders
// ============================================================
// Fog color: #B8C4C8 = (0.72, 0.77, 0.78) — hazy grey-blue per spec §2/§8
static const char*tVS=R"(#version 300 es
precision highp float;precision highp int;
layout(location=0)in vec3 aP;layout(location=1)in vec3 aN;layout(location=2)in vec3 aC;
out vec3 vC,vN,vW;out float vF;uniform mat4 uVP;uniform vec3 uCamPos;
void main(){
    gl_Position=uVP*vec4(aP,1);
    vC=aC;vN=aN;vW=aP;
    float dist=length(aP-uCamPos);
    vF=clamp((dist-600.0)/900.0,0.0,0.92);
})";
static const char*tFS=R"(#version 300 es
precision highp float;precision highp int;in vec3 vC,vN,vW;in float vF;out vec4 F;uniform vec3 uSun;
void main(){
    float d=max(dot(vN,uSun),0.0)*0.65+0.35;
    vec3 c=vC*d;
    c=mix(c,vec3(0.722,0.769,0.784),vF);
    F=vec4(c,1);
})";
static const char*oVS=R"(#version 300 es
precision highp float;precision highp int;
layout(location=0)in vec3 aP;layout(location=1)in vec3 aC;out vec3 vC;out float vF;uniform mat4 uVP;
void main(){gl_Position=uVP*vec4(aP,1);vC=aC;vF=clamp(gl_Position.z/900.0,0.0,0.92);})";
static const char*oFS=R"(#version 300 es
precision highp float;precision highp int;in vec3 vC;in float vF;out vec4 F;uniform float uA;
void main(){vec3 c=mix(vC,vec3(0.722,0.769,0.784),vF);F=vec4(c,uA);})";
static const char*hVS=R"(#version 300 es
precision highp float;precision highp int;
layout(location=0)in vec2 aP;layout(location=1)in vec3 aC;out vec3 vC;
void main(){gl_Position=vec4(aP,0,1);vC=aC;})";
static const char*hFS=R"(#version 300 es
precision highp float;precision highp int;in vec3 vC;out vec4 F;void main(){F=vec4(vC,0.85);})";

// DTS model shader: zone-based team coloring, correct specular, metallic look
static const char*dtsVS=R"(#version 300 es
precision highp float;precision highp int;
layout(location=0)in vec3 aP;layout(location=1)in vec3 aN;
out vec3 vN;out vec3 vWorldPos;out float vF;out float vZone;
uniform mat4 uVP;uniform mat4 uModel;uniform vec3 uCamPos;
void main(){
    vec4 wp=uModel*vec4(aP,1);
    gl_Position=uVP*wp;
    vN=normalize(mat3(uModel)*aN);
    vWorldPos=wp.xyz;
    float dist=length(wp.xyz-uCamPos);
    vF=clamp((dist-600.0)/900.0,0.0,0.92);
    vZone=aP.y; // model-space Y: upper body positive, lower negative
})";
static const char*dtsFS=R"(#version 300 es
precision highp float;precision highp int;
in vec3 vN;in vec3 vWorldPos;in float vF;in float vZone;
out vec4 F;
uniform vec3 uSun;uniform vec3 uTint;uniform vec3 uTint2;
uniform vec3 uCamPos;uniform float uA;
void main(){
    vec3 n=normalize(vN);
    // Zone blend: upper body/torso=primary, lower/limbs=secondary
    float zone=smoothstep(-0.1,0.25,vZone);
    vec3 baseColor=mix(uTint2,uTint,zone);
    // Lighting
    float diff=max(dot(n,uSun),0.0)*0.65;
    float amb=0.30;
    float hemi=dot(n,vec3(0,1,0))*0.12+0.08;
    // Correct viewDir from camera position
    vec3 viewDir=normalize(uCamPos-vWorldPos);
    // Metallic specular (higher exponent, warm tint)
    vec3 halfDir=normalize(uSun+viewDir);
    float spec=pow(max(dot(n,halfDir),0.0),52.0)*0.55;
    // Cool rim light for silhouette definition
    float rim=pow(1.0-max(dot(n,viewDir),0.0),3.0)*0.20;
    vec3 col=baseColor*(diff+amb+hemi);
    col+=vec3(1.0,0.92,0.82)*spec; // warm metallic specular
    col+=vec3(0.45,0.5,0.6)*rim;   // cool rim
    col=mix(col,vec3(0.722,0.769,0.784),vF);
    F=vec4(col,uA);
})";

static GLuint tShader,oShader,hShader,dtsShader;
static GLint tVPLoc,tSunLoc,tCamPosLoc,oVPLoc,oALoc;
static GLint dtsVPLoc,dtsModelLoc,dtsSunLoc,dtsTintLoc,dtsTint2Loc,dtsCamPosLoc,dtsALoc;
static GLuint oVAO,oVBO,hVAO,hVBO;

static GLuint compS(GLenum t,const char*s){
    GLuint sh=glCreateShader(t);glShaderSource(sh,1,&s,0);glCompileShader(sh);
    GLint ok=0;glGetShaderiv(sh,GL_COMPILE_STATUS,&ok);
    if(!ok){char log[512];glGetShaderInfoLog(sh,512,0,log);
        printf("[SHADER] Compile error (%s):\n%s\n",t==GL_VERTEX_SHADER?"VS":"FS",log);}
    return sh;
}
static GLuint linkP(const char*v,const char*f){
    GLuint p=glCreateProgram();
    GLuint vs=compS(GL_VERTEX_SHADER,v),fs=compS(GL_FRAGMENT_SHADER,f);
    glAttachShader(p,vs);glAttachShader(p,fs);glLinkProgram(p);
    GLint ok=0;glGetProgramiv(p,GL_LINK_STATUS,&ok);
    if(!ok){char log[512];glGetProgramInfoLog(p,512,0,log);
        printf("[SHADER] Link error: %s\n",log);}
    glDeleteShader(vs);glDeleteShader(fs);return p;
}

// ============================================================
// DTS GPU Model
// ============================================================
struct GPUModel {
    GLuint vao, vbo, ebo;
    int indexCount;
    float scale;       // world-space scale factor
    float offsetY;     // vertical offset so model sits on ground
    bool valid;        // true if loaded and uploaded successfully
};

// Loaded DTS source data (kept briefly during init, then freed)
static LoadedModel mdlLightArmor, mdlMediumArmor, mdlHeavyArmor;
static LoadedModel mdlDisc, mdlChaingun, mdlGrenade, mdlTower;

// GPU handles
static GPUModel gpuArmor[3];   // indexed by ArmorType
static GPUModel gpuDisc;
static GPUModel gpuTower;

// Quaternion rotation of a point
static Vec3 quatRotate(float qx,float qy,float qz,float qw, Vec3 v){
    Vec3 u={qx,qy,qz};
    float s=qw;
    float d=u.dot(v);
    Vec3 c=u.cross(v);
    return u*(2.0f*d) + v*(s*s - u.dot(u)) + c*(2.0f*s);
}

// Compute accumulated world transform for a node by walking to root
static void getNodeWorldTransform(const LoadedModel& model, int nodeIdx,
                                   float& outQx, float& outQy, float& outQz, float& outQw,
                                   float& outTx, float& outTy, float& outTz) {
    outQx=0; outQy=0; outQz=0; outQw=1;
    outTx=0; outTy=0; outTz=0;

    if (nodeIdx < 0 || nodeIdx >= (int)model.nodes.size()) return;

    // Walk from node to root, collecting transforms
    int chain[64]; int depth=0;
    int cur = nodeIdx;
    while(cur >= 0 && cur < (int)model.nodes.size() && depth < 64) {
        chain[depth++] = cur;
        cur = model.nodes[cur].parent;
    }

    // Apply transforms from root to leaf
    for (int i = depth-1; i >= 0; i--) {
        int ni = chain[i];
        int ti = model.nodes[ni].defaultTransform;
        if (ti < 0 || ti >= (int)model.transforms.size()) continue;

        const DTSTransform& t = model.transforms[ti];

        // Rotate current translation by parent's accumulated rotation
        Vec3 rotatedT = quatRotate(outQx,outQy,outQz,outQw, Vec3(t.tx,t.ty,t.tz));
        outTx += rotatedT.x;
        outTy += rotatedT.y;
        outTz += rotatedT.z;

        // Multiply quaternions: result = parent * child
        float ax=outQx,ay=outQy,az=outQz,aw=outQw;
        float bx=t.qx,by=t.qy,bz=t.qz,bw=t.qw;
        outQw = aw*bw - ax*bx - ay*by - az*bz;
        outQx = aw*bx + ax*bw + ay*bz - az*by;
        outQy = aw*by - ax*bz + ay*bw + az*bx;
        outQz = aw*bz + ax*by - ay*bx + az*bw;
    }
}

static bool uploadModel(const LoadedModel& model, GPUModel& gpu, float scaleFactor) {
    int totalVerts = 0, totalIndices = 0;
    for (size_t m = 0; m < model.meshes.size(); m++) {
        totalVerts += model.meshes[m].vertexCount;
        totalIndices += (int)model.meshes[m].indices.size();
    }
    if (totalVerts == 0 || totalIndices == 0) {
        gpu.valid = false;
        return false;
    }

    std::vector<float> vbuf(totalVerts * 6);
    std::vector<unsigned int> ibuf(totalIndices);

    int vOff = 0, iOff = 0, baseVertex = 0;
    float minY = 1e9f, maxY = -1e9f;

    bool hasSkeleton = !model.nodes.empty() && !model.transforms.empty();

    for (size_t m = 0; m < model.meshes.size(); m++) {
        const LoadedMesh& mesh = model.meshes[m];

        // Compute skeleton transform for this mesh's node
        float nqx=0,nqy=0,nqz=0,nqw=1, ntx=0,nty=0,ntz=0;
        if (hasSkeleton && mesh.nodeIndex >= 0) {
            getNodeWorldTransform(model, mesh.nodeIndex, nqx,nqy,nqz,nqw, ntx,nty,ntz);
        }

        for (int i = 0; i < mesh.vertexCount; i++) {
            float dx = mesh.vertices[i*3+0] + mesh.offsetX;
            float dy = mesh.vertices[i*3+1] + mesh.offsetY;
            float dz = mesh.vertices[i*3+2] + mesh.offsetZ;

            // Apply skeleton transform (in DTS space, before axis swap)
            if (hasSkeleton && mesh.nodeIndex >= 0) {
                Vec3 rotated = quatRotate(nqx,nqy,nqz,nqw, Vec3(dx,dy,dz));
                dx = rotated.x + ntx;
                dy = rotated.y + nty;
                dz = rotated.z + ntz;
            }

            // DTS Z-up → GL Y-up
            // Darkstar: X=right, Y=forward, Z=up
            // WebGL:    X=right, Y=up, Z=backward
            float gx = dx;
            float gy = dz;    // DTS Z (up) → GL Y (up)
            float gz = dy;    // DTS Y (forward) → GL Z (forward)

            vbuf[vOff*6+0] = gx;
            vbuf[vOff*6+1] = gy;
            vbuf[vOff*6+2] = gz;

            // Normals: apply rotation then axis swap
            float dnx = mesh.normals[i*3+0];
            float dny = mesh.normals[i*3+1];
            float dnz = mesh.normals[i*3+2];
            if (hasSkeleton && mesh.nodeIndex >= 0) {
                Vec3 rn = quatRotate(nqx,nqy,nqz,nqw, Vec3(dnx,dny,dnz));
                dnx=rn.x; dny=rn.y; dnz=rn.z;
            }
            vbuf[vOff*6+3] = dnx;
            vbuf[vOff*6+4] = dnz;
            vbuf[vOff*6+5] = dny;

            if (gy < minY) minY = gy;
            if (gy > maxY) maxY = gy;

            vOff++;
        }
        for (size_t i = 0; i < mesh.indices.size(); i++) {
            ibuf[iOff++] = mesh.indices[i] + baseVertex;
        }
        baseVertex += mesh.vertexCount;
    }

    // Upload to GPU
    glGenVertexArrays(1, &gpu.vao);
    glGenBuffers(1, &gpu.vbo);
    glGenBuffers(1, &gpu.ebo);

    glBindVertexArray(gpu.vao);
    glBindBuffer(GL_ARRAY_BUFFER, gpu.vbo);
    glBufferData(GL_ARRAY_BUFFER, vbuf.size() * sizeof(float), vbuf.data(), GL_STATIC_DRAW);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, gpu.ebo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, ibuf.size() * sizeof(unsigned int), ibuf.data(), GL_STATIC_DRAW);

    // layout(location=0) = position (3 floats)
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 6*sizeof(float), (void*)0);
    glEnableVertexAttribArray(0);
    // layout(location=1) = normal (3 floats)
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 6*sizeof(float), (void*)(3*sizeof(float)));
    glEnableVertexAttribArray(1);

    glBindVertexArray(0);

    gpu.indexCount = totalIndices;
    gpu.scale = scaleFactor;
    gpu.offsetY = -minY * scaleFactor; // lift model so its bottom sits at y=0
    gpu.valid = true;

    printf("[DTS] Uploaded model: %d verts, %d indices, height range [%.2f..%.2f], scale=%.2f\n",
           totalVerts, totalIndices, minY, maxY, scaleFactor);
    return true;
}

// r2/g2/b2 = secondary zone color (-1 means same as primary)
static void renderDTSModel(const GPUModel& gpu, const Mat4& vp, Vec3 pos, float yaw,
                            float r, float g, float b, float alpha=1.0f,
                            float r2=-1, float g2=-1, float b2=-1,
                            float breathY=0, Vec3 camPos={0,0,0}) {
    if (!gpu.valid) return;
    if(r2<0){r2=r;g2=g;b2=b;}

    Mat4 model = Mat4::translate(pos.x, pos.y + gpu.offsetY + breathY, pos.z)
               * Mat4::rotateY(yaw)
               * Mat4::scale(gpu.scale, gpu.scale, gpu.scale);

    static Vec3 sun=Vec3(0.4f,0.8f,0.3f).normalized();
    glUseProgram(dtsShader);
    glUniformMatrix4fv(dtsVPLoc, 1, GL_FALSE, vp.m);
    glUniformMatrix4fv(dtsModelLoc, 1, GL_FALSE, model.m);
    glUniform3f(dtsSunLoc, sun.x, sun.y, sun.z);
    glUniform3f(dtsTintLoc, r, g, b);
    glUniform3f(dtsTint2Loc, r2, g2, b2);
    glUniform3f(dtsCamPosLoc, camPos.x, camPos.y, camPos.z);
    glUniform1f(dtsALoc, alpha);

    glBindVertexArray(gpu.vao);
    glDrawElements(GL_TRIANGLES, gpu.indexCount, GL_UNSIGNED_INT, 0);
}

// ============================================================
// Object batch rendering (kept for flags, particles, fallback boxes)
// ============================================================
struct OV{float x,y,z,r,g,b;};
static std::vector<OV>oBatch;

static void pushBox(Vec3 p,Vec3 sz,float r,float g,float b){
    float x0=p.x-sz.x,x1=p.x+sz.x,y0=p.y,y1=p.y+sz.y,z0=p.z-sz.z,z1=p.z+sz.z;
    float dr=r*0.6f,dg=g*0.6f,db=b*0.6f;
    // top
    oBatch.push_back({x0,y1,z0,r,g,b});oBatch.push_back({x1,y1,z0,r,g,b});oBatch.push_back({x0,y1,z1,r,g,b});
    oBatch.push_back({x1,y1,z0,r,g,b});oBatch.push_back({x1,y1,z1,r,g,b});oBatch.push_back({x0,y1,z1,r,g,b});
    // front
    oBatch.push_back({x0,y0,z1,dr,dg,db});oBatch.push_back({x1,y0,z1,dr,dg,db});oBatch.push_back({x0,y1,z1,r,g,b});
    oBatch.push_back({x1,y0,z1,dr,dg,db});oBatch.push_back({x1,y1,z1,r,g,b});oBatch.push_back({x0,y1,z1,r,g,b});
    // right
    oBatch.push_back({x1,y0,z0,dr,dg,db});oBatch.push_back({x1,y0,z1,dr,dg,db});oBatch.push_back({x1,y1,z0,r,g,b});
    oBatch.push_back({x1,y0,z1,dr,dg,db});oBatch.push_back({x1,y1,z1,r,g,b});oBatch.push_back({x1,y1,z0,r,g,b});
    // left
    oBatch.push_back({x0,y0,z1,dr,dg,db});oBatch.push_back({x0,y0,z0,dr,dg,db});oBatch.push_back({x0,y1,z1,r,g,b});
    oBatch.push_back({x0,y0,z0,dr,dg,db});oBatch.push_back({x0,y1,z0,r,g,b});oBatch.push_back({x0,y1,z1,r,g,b});
    // back
    oBatch.push_back({x1,y0,z0,dr,dg,db});oBatch.push_back({x0,y0,z0,dr,dg,db});oBatch.push_back({x1,y1,z0,r,g,b});
    oBatch.push_back({x0,y0,z0,dr,dg,db});oBatch.push_back({x0,y1,z0,r,g,b});oBatch.push_back({x1,y1,z0,r,g,b});
}

static void pushPlayerModel(Vec3 p,float yaw,int team,ArmorType a,bool alive){
    float s=armors[a].hitW;
    float h=armors[a].hitH;
    float tr=team==0?0.7f:0.15f, tg=0.15f, tb=team==0?0.15f:0.7f;
    if(!alive){tr*=0.4f;tg*=0.4f;tb*=0.4f;}
    // Body
    pushBox(p,Vec3(s,h*0.6f,s*0.8f),tr,tg,tb);
    // Head
    Vec3 headP=p+Vec3(0,h*0.6f,0);
    pushBox(headP,Vec3(s*0.5f,s*0.6f,s*0.5f),tr*1.3f,tg*1.3f+0.1f,tb*1.3f);
    // Jetpack
    Vec3 jetP=p+Vec3(-sinf(yaw)*s*0.6f,h*0.3f,cosf(yaw)*s*0.6f);
    pushBox(jetP,Vec3(s*0.4f,h*0.25f,s*0.3f),0.3f,0.3f,0.35f);
}

static void pushFlag(Vec3 p,int team,float t){
    float r=team==0?1.0f:0.2f, g=0.15f, b=team==0?0.15f:1.0f;
    float pw=0.1f,ph=6.0f;
    // Pole
    oBatch.push_back({p.x-pw,p.y,p.z,0.5f,0.5f,0.5f});oBatch.push_back({p.x+pw,p.y,p.z,0.5f,0.5f,0.5f});
    oBatch.push_back({p.x-pw,p.y+ph,p.z,0.7f,0.7f,0.7f});
    oBatch.push_back({p.x+pw,p.y,p.z,0.5f,0.5f,0.5f});oBatch.push_back({p.x+pw,p.y+ph,p.z,0.7f,0.7f,0.7f});
    oBatch.push_back({p.x-pw,p.y+ph,p.z,0.7f,0.7f,0.7f});
    // Cloth
    float fw=3.5f,fh=2.0f;
    for(int i=0;i<6;i++){
        float t0=(float)i/6,t1=(float)(i+1)/6;
        float w0=sinf(t*4+t0*3)*0.4f*t0,w1=sinf(t*4+t1*3)*0.4f*t1;
        float x0=p.x+t0*fw,x1=p.x+t1*fw,yt=p.y+ph,yb=p.y+ph-fh;
        float f=1-t0*0.3f;
        oBatch.push_back({x0,yt+w0,p.z,r*f,g*f,b*f});oBatch.push_back({x1,yt+w1,p.z,r*f,g*f,b*f});
        oBatch.push_back({x0,yb+w0,p.z,r*f*0.7f,g*f*0.7f,b*f*0.7f});
        oBatch.push_back({x1,yt+w1,p.z,r*f,g*f,b*f});oBatch.push_back({x1,yb+w1,p.z,r*f*0.7f,g*f*0.7f,b*f*0.7f});
        oBatch.push_back({x0,yb+w0,p.z,r*f*0.7f,g*f*0.7f,b*f*0.7f});
    }
}

static void pushDisc(Vec3 p,float sz,float rot,float r,float g,float b){
    for(int i=0;i<12;i++){
        float a0=rot+(float)i/12*2*PI,a1=rot+(float)(i+1)/12*2*PI;
        oBatch.push_back({p.x,p.y,p.z,r*1.2f,g*1.2f,b*1.2f});
        oBatch.push_back({p.x+cosf(a0)*sz,p.y+sinf(a0)*sz*0.3f,p.z+sinf(a0)*sz,r,g,b});
        oBatch.push_back({p.x+cosf(a1)*sz,p.y+sinf(a1)*sz*0.3f,p.z+sinf(a1)*sz,r,g,b});
    }
}

static void flushObj(const Mat4&vp,float alpha=1){
    if(oBatch.empty())return;
    glUseProgram(oShader);glUniformMatrix4fv(oVPLoc,1,0,vp.m);glUniform1f(oALoc,alpha);
    glBindVertexArray(oVAO);glBindBuffer(GL_ARRAY_BUFFER,oVBO);
    glBufferData(GL_ARRAY_BUFFER,oBatch.size()*sizeof(OV),oBatch.data(),GL_DYNAMIC_DRAW);
    glVertexAttribPointer(0,3,GL_FLOAT,0,sizeof(OV),(void*)0);glEnableVertexAttribArray(0);
    glVertexAttribPointer(1,3,GL_FLOAT,0,sizeof(OV),(void*)12);glEnableVertexAttribArray(1);
    glDrawArrays(GL_TRIANGLES,0,oBatch.size());oBatch.clear();
}

// ============================================================
// Input
// ============================================================
static bool keys[256]={};
static float mDX=0,mDY=0;
static bool ptrLocked=false,fireDown=false;
static EM_BOOL onKD(int,const EmscriptenKeyboardEvent*e,void*){if(e->keyCode<256)keys[e->keyCode]=true;return 1;}
static EM_BOOL onKU(int,const EmscriptenKeyboardEvent*e,void*){if(e->keyCode<256)keys[e->keyCode]=false;return 1;}
static EM_BOOL onMM(int,const EmscriptenMouseEvent*e,void*){if(ptrLocked){mDX+=e->movementX;mDY+=e->movementY;}return 1;}
static EM_BOOL onMD(int,const EmscriptenMouseEvent*,void*){fireDown=true;return 1;}
static EM_BOOL onMU(int,const EmscriptenMouseEvent*,void*){fireDown=false;return 1;}
static EM_BOOL onPL(int,const EmscriptenPointerlockChangeEvent*e,void*){ptrLocked=e->isActive;return 1;}

// ============================================================
// Game logic
// ============================================================
static float gameTime=0;
static double lastTime=0;
static int frameCount=0;
static bool thirdPerson=false;
// R31.7 C1: 3P aim convergence — JS sets this each frame via setLocalAimPoint3P()
static Vec3 aimPoint3P={0,0,0};
static bool hasAimPoint3P=false;
static const float ENERGY_RECHARGE=8.0f; // per second

static void fireWeapon(int pi){
    Player&p=players[pi];
    if(p.fireCooldown>0||!p.alive)return;
    const WeaponData&w=weapons[p.curWeapon];
    if(w.usesAmmo&&p.ammo[p.curWeapon]<=0)return;
    if(!w.usesAmmo&&p.energy<w.energyCost)return;

    Vec3 fwd={sinf(p.yaw)*cosf(p.pitch),sinf(p.pitch),-cosf(p.yaw)*cosf(p.pitch)};
    Vec3 firePos=p.pos+Vec3(0,2,0)+fwd*2;
    // R31.7 C1: 3P aim convergence — override fwd to point firePos→crosshair world point.
    // Without this, the +0.7m (R31.5) or centered (R31.7) camera offset makes shots land
    // 1-2 m off where the crosshair points at medium range.
    if(thirdPerson&&pi==localPlayer&&hasAimPoint3P){
        Vec3 toAim=aimPoint3P-firePos;
        float l=toAim.len();
        if(l>1.0f) fwd=toAim*(1.0f/l);
    }

    if(w.muzzleVel>0&&p.curWeapon!=WPN_LASER){
        for(int i=0;i<MAX_PROJ;i++)if(!projs[i].active){
            projs[i].pos=firePos;
            projs[i].vel=fwd*w.muzzleVel+p.vel*w.inheritScale; // F6: per-weapon inheritance
            projs[i].life=w.projLife;
            projs[i].weapon=p.curWeapon;
            projs[i].ownerTeam=p.team;
            projs[i].active=true;
            spawnBurst(firePos,3,0.3f,5,w.r,w.g,w.b,0.2f);
            break;
        }
    }
    if(w.usesAmmo)p.ammo[p.curWeapon]--;
    else p.energy-=w.energyCost;
    p.fireCooldown=w.fireTime+w.reloadTime;
    if(w.kickback>0)p.vel-=fwd*(w.kickback*0.01f);
    // Fire sound (local player only — UI bus, not positional)
    if(pi==localPlayer){
        int sndId=p.curWeapon; // weapon enum matches sound slot 0-8
        EM_ASM({ if(window.playSoundUI)window.playSoundUI($0); }, sndId);
    }
}

static void respawnPlayer(int pi){
    Player&p=players[pi];
    Vec3 base=flags[p.team].homePos;
    p.pos=base+Vec3((rand()%20)-10,5,(rand()%20)-10);
    p.vel={0,0,0};
    p.health=armors[p.armor].maxDamage;
    p.energy=armors[p.armor].maxEnergy;
    p.alive=true;
    p.carryingFlag=-1;
    p.curWeapon=WPN_DISC;
    p.fireCooldown=0;
    p.airSkiTimer=0; // F2: reset so a freshly-respawned player can't inherit stale timer
    // Spawn loadout: blaster, chaingun, disc
    memset(p.ammo,0,sizeof(p.ammo));
    p.ammo[WPN_CHAINGUN]=armors[p.armor].maxBullet;
    p.ammo[WPN_DISC]=armors[p.armor].maxDisc;
    p.ammo[WPN_GRENADE_LAUNCHER]=armors[p.armor].maxGrenadeAmmo;
    p.ammo[WPN_PLASMA]=armors[p.armor].maxPlasma;
    p.ammo[WPN_MORTAR]=armors[p.armor].maxMortarAmmo;
    g_spawnProtect[pi]=gameTime+3.0f; // 3s invulnerability
    if(pi==localPlayer)g_localRespawnTimer=0;
}

// D2: last attacker team that caused damage (used for hit-confirm callback)
static int g_lastAttackerTeam=-1;
static float g_lastDmg=0;

static void damagePlayer(int pi,float dmg,int attackerTeam){
    Player&p=players[pi];
    if(!p.alive)return;
    if(g_matchState==0)return; // no damage during warmup
    if(g_matchState==2)return; // no damage after match ends
    if(gameTime<g_spawnProtect[pi])return; // spawn protection
    // D2: hit-confirm crosshair tick when local player's shot hits a non-teammate
    if(attackerTeam==players[localPlayer].team && pi!=localPlayer && dmg>0){
        EM_ASM({ if(window.onHitConfirm)window.onHitConfirm($0); }, (double)dmg);
    }
    p.health-=dmg;
    if(p.health<=0){
        p.health=0;p.alive=false;p.deaths++;
        if(p.carryingFlag>=0){
            flags[p.carryingFlag].carried=false;
            flags[p.carryingFlag].pos=p.pos;
            flags[p.carryingFlag].atHome=false;
            flags[p.carryingFlag].dropTimer=FLAG_RETURN_TIME;
            p.carryingFlag=-1;
        }
        // Respawn after 3s
    }
}

// ============================================================
// Nav grid + A* pathfinding
// ============================================================
static void initNavGrid(){
    for(int i=0;i<NAV_SIZE;i++) for(int j=0;j<NAV_SIZE;j++){
        float cx=(i-NAV_SIZE/2)*NAV_CELL+NAV_CELL/2;
        float cz=(j-NAV_SIZE/2)*NAV_CELL+NAV_CELL/2;
        g_navWalkable[i][j]=true;
        for(int k=0;k<numBuildings;k++){
            if(buildings[k].isRock)continue;
            const Building&b=buildings[k];
            if(fabsf(cx-b.pos.x)<b.halfSize.x+10&&fabsf(cz-b.pos.z)<b.halfSize.z+10){
                g_navWalkable[i][j]=false;break;
            }
        }
    }
    printf("[Nav] Grid initialized (%dx%d, %.0fm cells)\n",NAV_SIZE,NAV_SIZE,NAV_CELL);
}

static void worldToNav(float wx,float wz,int&ni,int&nj){
    ni=(int)(wx/NAV_CELL+NAV_SIZE/2);nj=(int)(wz/NAV_CELL+NAV_SIZE/2);
    ni=std::max(0,std::min(NAV_SIZE-1,ni));nj=std::max(0,std::min(NAV_SIZE-1,nj));
}
static Vec3 navToWorld(int ni,int nj){
    return {(ni-NAV_SIZE/2)*NAV_CELL+NAV_CELL/2,0,(nj-NAV_SIZE/2)*NAV_CELL+NAV_CELL/2};
}

struct NavNode{int idx,f;bool operator>(const NavNode&o)const{return f>o.f;}};

static std::vector<Vec3> astarPath(float sx,float sz,float ex,float ez){
    int si,sj,ei,ej;
    worldToNav(sx,sz,si,sj);worldToNav(ex,ez,ei,ej);
    if(si==ei&&sj==ej)return {};
    for(int i=0;i<NAV_SIZE*NAV_SIZE;i++){s_gCost[i/NAV_SIZE][i%NAV_SIZE]=0x7fffffff;s_closed[i/NAV_SIZE][i%NAV_SIZE]=false;s_parent[i]=-1;}
    std::priority_queue<NavNode,std::vector<NavNode>,std::greater<NavNode>> open;
    int startIdx=si*NAV_SIZE+sj;
    s_gCost[si][sj]=0;open.push({startIdx,abs(si-ei)+abs(sj-ej)});
    int endIdx=ei*NAV_SIZE+ej;
    int iters=0;
    static const int DX[]={0,0,1,-1,1,1,-1,-1};
    static const int DZ[]={1,-1,0,0,1,-1,1,-1};
    static const int DC[]={10,10,10,10,14,14,14,14};
    while(!open.empty()&&iters<2000){
        iters++;
        NavNode cur=open.top();open.pop();
        int ci=cur.idx/NAV_SIZE,cj=cur.idx%NAV_SIZE;
        if(s_closed[ci][cj])continue;
        s_closed[ci][cj]=true;
        if(cur.idx==endIdx){
            std::vector<Vec3> path;
            int idx=endIdx;
            while(idx!=-1&&idx!=startIdx){
                int ni=idx/NAV_SIZE,nj=idx%NAV_SIZE;
                Vec3 wp=navToWorld(ni,nj);wp.y=getH(wp.x,wp.z)+1.5f;
                path.push_back(wp);idx=s_parent[idx];
            }
            std::reverse(path.begin(),path.end());
            return path;
        }
        for(int d=0;d<8;d++){
            int ni=ci+DX[d],nj=cj+DZ[d];
            if(ni<0||ni>=NAV_SIZE||nj<0||nj>=NAV_SIZE)continue;
            if(!g_navWalkable[ni][nj])continue;
            int nidx=ni*NAV_SIZE+nj;
            if(s_closed[ni][nj])continue;
            int ng=s_gCost[ci][cj]+DC[d];
            if(ng<s_gCost[ni][nj]){
                s_gCost[ni][nj]=ng;s_parent[nidx]=cur.idx;
                open.push({nidx,ng+(abs(ni-ei)+abs(nj-ej))*10});
            }
        }
    }
    return {};
}

static void assignBotRole(int pi){
    Player&p=players[pi];
    if(!p.isBot)return;
    // Count existing roles on this team
    int counts[3]={0,0,0};
    for(int i=0;i<MAX_PLAYERS;i++){
        if(i==pi||!players[i].active||!players[i].isBot||players[i].team!=p.team)continue;
        counts[players[i].botRole]++;
    }
    // Target distribution per 4-bot team: 2 OFF / 1 DEF / 1 MID
    if(counts[1]<1){p.botRole=1;}      // need defender
    else if(counts[2]<1){p.botRole=2;} // need midfield
    else{p.botRole=0;}                 // default offense
}

static void updateBot(int pi,float dt){
    Player&p=players[pi];
    // Respawn handling
    if(!p.alive){
        static float respawnTimers[8]={};
        respawnTimers[pi]+=dt;
        if(respawnTimers[pi]>5.0f){respawnPlayer(pi);assignBotRole(pi);respawnTimers[pi]=0;
            g_botPath[pi].clear();g_botPathIdx[pi]=0;g_botPathTimer[pi]=0;}
        return;
    }

    const ArmorData&ad=armors[p.armor];
    int enemyTeam=1-p.team;

    // ------- STUCK DETECTION -------
    g_botStuckAccum[pi]+=dt;
    if(g_botStuckAccum[pi]>=1.5f){
        float moved=(p.pos-g_botLastPos[pi]).len();
        g_botLastPos[pi]=p.pos;g_botStuckAccum[pi]=0;
        // Check: is bot in active combat? (enemy within 40m counts)
        bool inCombat=false;
        for(int i=0;i<MAX_PLAYERS;i++){
            if(!players[i].active||!players[i].alive||players[i].team==p.team)continue;
            if((players[i].pos-p.pos).lenSq()<1600){inCombat=true;break;}
        }
        if(moved<1.5f&&!inCombat){
            // Stuck: jump + randomize yaw + clear path
            p.vel.y+=8.0f;
            p.yaw+=(rand()%100-50)*0.01f;
            g_botPath[pi].clear();g_botPathIdx[pi]=0;g_botPathTimer[pi]=0;
        }
    }

    // ------- DESTINATION SELECTION -------
    Vec3 destination={};
    bool isCarrying=(p.carryingFlag>=0);
    float pathRecomputeInterval=isCarrying?1.0f:2.0f;

    g_botPathTimer[pi]-=dt;
    bool needRecompute=(g_botPathTimer[pi]<=0)||
                       (g_botPathIdx[pi]>=(int)g_botPath[pi].size());

    if(p.botRole==0||isCarrying){ // OFFENSE or flag carrier
        if(isCarrying){
            destination=flags[p.team].homePos;
            // Flag-runner event broadcast (once per pickup)
            g_botFlagEventTimer[pi]-=dt;
            if(g_botFlagEventTimer[pi]<=0){
                g_botFlagEventTimer[pi]=30.0f;
                printf("[EVENT] %s has the flag — running home!\n",p.name);
            }
        }else{
            // Go for enemy flag
            destination=flags[enemyTeam].pos;
        }
    }else if(p.botRole==1){ // DEFENSE
        Vec3 homeFlag=flags[p.team].homePos;
        // If enemy is near home flag or carrying it, engage; else patrol
        bool flagTaken=flags[p.team].carried;
        bool enemyNearHome=false;
        int chaseTarget=-1;
        for(int i=0;i<MAX_PLAYERS;i++){
            if(!players[i].active||!players[i].alive||players[i].team==p.team)continue;
            float d=(players[i].pos-homeFlag).lenSq();
            if(d<10000||players[i].carryingFlag==p.team){enemyNearHome=true;chaseTarget=i;break;}
        }
        if(enemyNearHome&&chaseTarget>=0){
            destination=players[chaseTarget].pos;
        }else if(flagTaken&&flags[p.team].carrierIdx>=0){
            destination=players[flags[p.team].carrierIdx].pos; // chase carrier
        }else{
            // Patrol: alternate between home flag and nearest station within 80m
            static float defPatrolTimer[8]={};
            defPatrolTimer[pi]-=dt;
            if(defPatrolTimer[pi]<=0){defPatrolTimer[pi]=5.0f+rand()%4;}
            float pr=fmodf(gameTime+pi*7.3f,10.0f);
            if(pr<5){destination=homeFlag;}
            else{
                // Find nearest station on same team
                int bestS=-1;float bestD=1e9f;
                for(int i=0;i<RAINDANCE_STATION_COUNT;i++){
                    int st=(strstr(RAINDANCE_STATIONS[i].team,"team0")?0:1);
                    if(st!=p.team)continue;
                    Vec3 sp={RAINDANCE_STATIONS[i].x,RAINDANCE_STATIONS[i].z,-RAINDANCE_STATIONS[i].y};
                    float d=(sp-homeFlag).lenSq();if(d<bestD){bestD=d;bestS=i;}
                }
                if(bestS>=0){
                    destination={RAINDANCE_STATIONS[bestS].x,
                                 RAINDANCE_STATIONS[bestS].z,
                                 -RAINDANCE_STATIONS[bestS].y};
                }else destination=homeFlag;
            }
        }
    }else{ // MIDFIELD
        // Engage nearest enemy or assist flag carrier
        int nearest=-1;float bestD=14400; // 120m
        for(int i=0;i<MAX_PLAYERS;i++){
            if(!players[i].active||!players[i].alive||players[i].team==p.team)continue;
            float d=(players[i].pos-p.pos).lenSq();
            if(d<bestD){bestD=d;nearest=i;}
        }
        if(nearest>=0)destination=players[nearest].pos;
        else{
            // Roam mid-map
            destination={(flags[0].homePos.x+flags[1].homePos.x)*0.5f,0,
                         (flags[0].homePos.z+flags[1].homePos.z)*0.5f};
        }
    }

    // ------- PATHFINDING -------
    if(needRecompute){
        g_botPathTimer[pi]=pathRecomputeInterval;
        g_botPath[pi]=astarPath(p.pos.x,p.pos.z,destination.x,destination.z);
        g_botPathIdx[pi]=0;
        if(g_botPath[pi].empty()){
            // Direct fallback
            g_botPath[pi].push_back({destination.x,getH(destination.x,destination.z)+1.5f,destination.z});
        }
    }

    // Current waypoint
    Vec3 waypoint=destination; // fallback
    if(g_botPathIdx[pi]<(int)g_botPath[pi].size()){
        waypoint=g_botPath[pi][g_botPathIdx[pi]];
        if((p.pos-waypoint).lenSq()<64){ // within 8m → advance
            g_botPathIdx[pi]++;
            if(g_botPathIdx[pi]<(int)g_botPath[pi].size())
                waypoint=g_botPath[pi][g_botPathIdx[pi]];
        }
    }

    // ------- MOVEMENT -------
    Vec3 toWP=waypoint-p.pos;float wpDist=toWP.len();
    if(wpDist>2){
        p.yaw=atan2f(toWP.x,-toWP.z);
        p.pitch=atan2f(toWP.y,sqrtf(toWP.x*toWP.x+toWP.z*toWP.z))*0.4f;
    }
    Vec3 flatFwd={sinf(p.yaw),0,-cosf(p.yaw)};
    float th=getH(p.pos.x,p.pos.z);
    p.onGround=(p.pos.y-th)<1.5f;

    // Skiing intent: downhill path direction + speed not maxed
    Vec3 norm=getNorm(p.pos.x,p.pos.z);
    float slope=1.0f-norm.y; // 0=flat, high=steep
    Vec3 pathDir=(wpDist>1)?toWP*(1.0f/wpDist):Vec3{0,0,0};
    float downhillDot=-pathDir.dot(norm)*norm.y; // positive if moving downhill
    bool shouldSki=p.onGround&&((downhillDot>0.1f&&p.speed<ad.maxFwdSpeed*2.2f)||slope>0.4f);

    if(p.onGround){
        if(shouldSki){
            Vec3 grav={0,-120*dt,0};
            p.vel+=grav-norm*(grav.dot(norm));
            p.vel+=flatFwd*(15*dt);
            p.vel.x*=0.997f;p.vel.z*=0.997f;
        }else{
            p.vel.x=flatFwd.x*ad.maxFwdSpeed;p.vel.z=flatFwd.z*ad.maxFwdSpeed;
            if(p.vel.y<0)p.vel.y=0;
        }
        p.skiing=shouldSki;
    }else{
        p.vel+=flatFwd*(28*dt);
        p.skiing=false;
    }

    // Jetting intent: next waypoint is uphill, or flag carrier being chased
    float waypointDY=waypoint.y-p.pos.y;
    bool beingChased=false;
    if(isCarrying){
        for(int i=0;i<MAX_PLAYERS;i++){
            if(!players[i].active||!players[i].alive||players[i].team==p.team)continue;
            if((players[i].pos-p.pos).lenSq()<3600){beingChased=true;break;} // 60m
        }
    }
    bool shouldJet=!p.onGround&&p.energy>ad.minJetEnergy*2.5f&&
                   (waypointDY>4||beingChased||(th>p.pos.y-5&&p.energy>ad.maxEnergy*0.5f));
    if(shouldJet){
        p.vel.y+=ad.jetForce/ad.mass*dt;
        p.energy-=ad.jetEnergyDrain/TICK*dt;
        p.jetting=true;
    }else{p.jetting=false;}

    if(!p.onGround)p.vel.y-=80*dt;
    p.energy+=ENERGY_RECHARGE*dt;
    if(p.energy>ad.maxEnergy)p.energy=ad.maxEnergy;
    if(p.energy<0)p.energy=0;

    p.pos+=p.vel*dt;
    th=getH(p.pos.x,p.pos.z);
    if(p.pos.y<th+1){p.pos.y=th+1;if(p.vel.y<0)p.vel.y=0;}
    resolvePlayerBuildingCollision(p.pos,p.vel,armors[p.armor].hitW,armors[p.armor].hitH);
    resolvePlayerInteriorCollision(p.pos,p.vel,armors[p.armor].hitW,armors[p.armor].hitH);
    p.speed=sqrtf(p.vel.x*p.vel.x+p.vel.z*p.vel.z);

    // ------- ENGAGEMENT (with LOS gating) -------
    p.fireCooldown-=dt;
    // Flag-runner only engages enemies within 30m
    float engageRange=(isCarrying?30.0f:80.0f);
    for(int i=0;i<MAX_PLAYERS;i++){
        if(i==pi||!players[i].active||!players[i].alive||players[i].team==p.team)continue;
        float d=(players[i].pos-p.pos).lenSq();
        if(d>engageRange*engageRange)continue;
        Vec3 toE=(players[i].pos-p.pos).normalized();
        // LoS check: sample 5 points between bot and enemy
        Vec3 fromPos=p.pos+Vec3(0,1.5f,0);
        Vec3 toPos=players[i].pos+Vec3(0,1.2f,0);
        bool los=true;
        for(int s=1;s<=5;s++){
            float t=(float)s/6;
            Vec3 pt=fromPos+toPos*(t)-fromPos*(t); // lerp
            pt=Vec3(fromPos.x+(toPos.x-fromPos.x)*t,
                    fromPos.y+(toPos.y-fromPos.y)*t,
                    fromPos.z+(toPos.z-fromPos.z)*t);
            if(pt.y<getH(pt.x,pt.z)+0.5f){los=false;break;}
        }
        if(!los)continue;
        p.yaw=atan2f(toE.x,-toE.z);
        p.pitch=atan2f(toE.y,sqrtf(toE.x*toE.x+toE.z*toE.z));
        fireWeapon(pi);
        break;
    }
}

// ============================================================
// HUD
// ============================================================
struct HV{float x,y,r,g,b;};
static std::vector<HV>hBatch;
static void hQ(float x1,float y1,float x2,float y2,float r,float g,float b){
    hBatch.push_back({x1,y1,r,g,b});hBatch.push_back({x2,y1,r,g,b});hBatch.push_back({x1,y2,r,g,b});
    hBatch.push_back({x2,y1,r,g,b});hBatch.push_back({x2,y2,r,g,b});hBatch.push_back({x1,y2,r,g,b});
}
static void drawHUD(){
    // HUD is now fully HTML/CSS — canvas is 3D-only.
    // This function is retained as a stub; HUD state is broadcast via EM_ASM in mainLoop.
    glEnable(GL_DEPTH_TEST);
}

static void broadcastHUD(){
    Player&p=players[localPlayer];
    const ArmorData&ad=armors[p.armor];
    float hpPct=p.alive?(p.health/ad.maxDamage)*100.0f:0.0f;
    float enCap=ad.maxEnergy*(p.pack==1?1.5f:1.0f);
    float enPct=(enCap>0)?(p.energy/enCap)*100.0f:0.0f;
    int curWpn=p.curWeapon;
    int ammo=p.ammo[curWpn];
    // Max ammo per armor
    int maxAmmo=20;
    if(curWpn==WPN_CHAINGUN)maxAmmo=(p.armor==ARMOR_LIGHT?100:p.armor==ARMOR_MEDIUM?150:200);
    else if(curWpn==WPN_DISC)maxAmmo=15;
    else if(curWpn==WPN_PLASMA)maxAmmo=(p.armor==ARMOR_LIGHT?30:p.armor==ARMOR_MEDIUM?40:50);
    else if(curWpn==WPN_GRENADE_LAUNCHER)maxAmmo=(p.armor==ARMOR_HEAVY?15:10);
    else if(curWpn==WPN_MORTAR)maxAmmo=10;
    if(p.pack==3)maxAmmo*=2;
    int speed10=(int)(p.speed*10);
    int timeRemain=(g_matchState==0)?(int)g_warmupTimer:(int)g_roundTimer;
    // Split into two calls: EM_ASM supports $0-$15 only (max 16 args)
    EM_ASM({
        if(window.updateHUD)window.updateHUD($0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
    },(int)hpPct,(int)enPct,ammo,maxAmmo,curWpn,speed10,
       p.skiing?1:0,p.carryingFlag,
       (int)p.pos.x,(int)p.pos.z,(int)(p.yaw*1000),
       teamScore[0],teamScore[1],(int)p.armor);
    // R22: also pass local-player spawn-protection remaining (deciseconds)
    float spRemain = (g_spawnProtect[localPlayer] > gameTime) ? (g_spawnProtect[localPlayer] - gameTime) : 0.0f;
    EM_ASM({
        if(window.updateMatchHUD)window.updateMatchHUD($0,$1,$2,$3);
    },g_matchState,timeRemain,(int)(g_localRespawnTimer*10),(int)(spRemain*10));
}

// ============================================================
// Turret + Generator update
// ============================================================
static bool hasLoS(Vec3 from, Vec3 to){
    Vec3 d=to-from;float dist=d.len();
    if(dist<0.1f)return true;
    d=d*(1.0f/dist);
    int steps=(int)(dist/5.0f)+2;
    for(int s=1;s<steps;s++){
        Vec3 pt=from+d*((float)s/steps*dist);
        if(pt.y<getH(pt.x,pt.z))return false;
        if(projectileHitsBuilding(pt))return false;
    }
    return true;
}

static void updateTurrets(float dt){
    for(int i=0;i<RAINDANCE_TURRET_COUNT;i++){
        Turret&t=turrets[i];
        if(!t.alive)continue;
        if(!generatorAlive[t.team])continue; // offline — gen destroyed
        t.scanTimer-=dt;t.fireCooldown-=dt;
        // Scan for nearest enemy every 200ms
        if(t.scanTimer<=0){
            t.scanTimer=0.2f;t.targetIdx=-1;
            float bestDist=80.0f*80.0f;
            for(int j=0;j<MAX_PLAYERS;j++){
                if(!players[j].active||!players[j].alive||players[j].team==t.team)continue;
                float d=(players[j].pos-t.pos).lenSq();
                if(d<bestDist){bestDist=d;t.targetIdx=j;}
            }
        }
        if(t.targetIdx<0||!players[t.targetIdx].active||!players[t.targetIdx].alive)continue;
        Vec3 toTgt=players[t.targetIdx].pos-t.pos;
        float targetYaw=atan2f(toTgt.x,-toTgt.z);
        // Smooth barrel rotation (120°/sec)
        float maxRot=120.0f*DEG2RAD*dt;
        float yawDiff=targetYaw-t.aimYaw;
        while(yawDiff>M_PI)yawDiff-=2*M_PI;while(yawDiff<-M_PI)yawDiff+=2*M_PI;
        t.aimYaw+=(yawDiff>0?1:-1)*fminf(fabsf(yawDiff),maxRot);
        // Fire plasma when within 15° and cooldown ready, with LoS check
        if(fabsf(yawDiff)<15.0f*DEG2RAD&&t.fireCooldown<=0){
            Vec3 firePos=t.pos+Vec3(0,2.5f,0);
            Vec3 tgtPos=players[t.targetIdx].pos+Vec3(0,1.2f,0);
            if(hasLoS(firePos,tgtPos)){
                Vec3 dir={sinf(t.aimYaw),0.05f,-cosf(t.aimYaw)};
                dir=dir.normalized();
                for(int k=0;k<MAX_PROJ;k++){
                    if(!projs[k].active){
                        projs[k]={firePos,dir*weapons[WPN_PLASMA].muzzleVel,
                                   weapons[WPN_PLASMA].projLife,WPN_PLASMA,t.team,true};
                        break;
                    }
                }
                // D3 R31.6: muzzle flash particle burst + positional plasma sound
                spawnBurst(firePos,6,0.4f,8, 1.0f,0.3f,0.1f, 0.25f);
                EM_ASM({if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2);},(double)firePos.x,(double)firePos.y,(double)firePos.z);
            }
            t.fireCooldown=1.5f; // reset regardless (don't rapid-fire when blocked)
        }
    }
}

static void updateGenerators(float dt){
    for(int i=0;i<RAINDANCE_GENERATOR_COUNT;i++){
        Generator&g=generators[i];
        g.sparkTimer-=dt;
        if(g.alive){
            // Alive state: ambient team-colored pulse every 2s
            if(g.sparkTimer<=0){
                g.sparkTimer=2.0f;
                float pr=(g.team==0?0.9f:0.15f),pg=0.15f,pb=(g.team==0?0.1f:0.8f);
                spawnPart(g.pos+Vec3(0,2.2f,0),Vec3(0,1.5f,0),pr,pg,pb,1.2f,0.22f);
            }
        }else{
            // Destroyed state: yellow sparks every 0.5s
            if(g.sparkTimer<=0){
                g.sparkTimer=0.5f;
                spawnPart(g.pos+Vec3(0,1,0),Vec3(0,3,0),1.0f,0.7f,0.1f,0.8f,0.15f);
            }
            // Regenerate if no enemies within 30m
            bool enemyNear=false;
            for(int j=0;j<MAX_PLAYERS;j++){
                if(!players[j].active||!players[j].alive||players[j].team==g.team)continue;
                if((players[j].pos-g.pos).lenSq()<900.0f){enemyNear=true;break;}
            }
            if(!enemyNear){
                g.hp+=5.0f*dt;
                if(g.hp>=800.0f){
                    g.hp=800.0f;g.alive=true;generatorAlive[g.team]=true;
                    printf("[CTF] >>> %s generator repaired — turrets online <<<\n",g.team==0?"RED":"BLUE");
                }
            }
        }
    }
}

static int openStationIdx=-1; // -1 = no station UI open

extern "C" void setGameSettings(int team,int armor,int botCount,int scoreLimit,int timeLimit){
    players[localPlayer].team=team;
    players[localPlayer].armor=(ArmorType)armor;
    g_scoreLimit=scoreLimit>0?scoreLimit:5;
    g_timeLimit=timeLimit;
    g_roundTimer=(float)timeLimit;
    // Reset match state for new game
    g_matchState=0;g_warmupTimer=15.0f;
    teamScore[0]=teamScore[1]=0;
    memset(g_warnedTime,0,sizeof(g_warnedTime));
    memset(g_spawnProtect,0,sizeof(g_spawnProtect));
    // Re-assign bot teams (simple split)
    int botsPerTeam=botCount/2;
    for(int i=1;i<MAX_PLAYERS;i++){
        players[i].active=(i<=botCount);
        if(players[i].active)players[i].team=(i<=botsPerTeam)?team:(1-team);
    }
}

extern "C" void updateScoreboard(){
    for(int i=0;i<MAX_PLAYERS;i++){
        if(!players[i].active)continue;
        EM_ASM({
            if(window.sbRow)window.sbRow($0,$1,$2,$3,$4,$5,$6,UTF8ToString($7));
        },i,players[i].team,players[i].score,players[i].kills,players[i].deaths,
          players[i].carryingFlag>=0?1:0,
          players[i].isBot?players[i].botRole:-1,
          players[i].name);
    }
    // Compute MVP (3*caps + 1*kills)
    int mvpIdx=0,mvpScore=-1;
    for(int i=0;i<MAX_PLAYERS;i++){
        if(!players[i].active)continue;
        int s=players[i].score*3+players[i].kills; // score already includes 5*caps+returns
        if(s>mvpScore){mvpScore=s;mvpIdx=i;}
    }
    EM_ASM({
        if(window.sbFinish)window.sbFinish($0,$1,$2,$3,UTF8ToString($4));
    },teamScore[0],teamScore[1],g_matchState,(int)g_roundTimer,players[mvpIdx].name);
}

// Exported: apply inventory station loadout (called from JS)
extern "C" void applyLoadout(int armor,int weapon,int pack){
    Player&me=players[localPlayer];
    me.armor=(ArmorType)armor;me.curWeapon=weapon;me.pack=pack;
    me.health=armors[armor].maxDamage;
    float enCap=armors[armor].maxEnergy*(pack==1?1.5f:1.0f);
    me.energy=enCap;
    if(pack==2)me.healTimer=10.0f;
    for(int i=0;i<WPN_COUNT;i++)me.ammo[i]=(pack==3?40:20);
    openStationIdx=-1;
    printf("[STATION:APPLIED]\n");
}

// R19: client prediction reconciliation — JS calls this when the server
// snapshot diverges from the predicted local-player state. Smooth
// correction is the JS layer's job (200ms interpolation per architecture
// §7); this function just sets the authoritative target.
// R26: replace `buildings[]` with map-driven AABBs. Packed format per brief:
//   6 floats per building = [minX, minY, minZ, maxX, maxY, maxZ].
// Caps at MAX_BUILDINGS (64) — silently truncates with a printf warning.
// Both resolvePlayerBuildingCollision() and projectileHitsBuilding() iterate
// buildings[] so collision automatically picks up the new geometry.
extern "C" void setMapBuildings(int count, float* aabbData){
    if(count > MAX_BUILDINGS){
        printf("[R26] setMapBuildings: count=%d exceeds MAX_BUILDINGS=%d, truncating\n", count, MAX_BUILDINGS);
        count = MAX_BUILDINGS;
    }
    if(count < 0) count = 0;
    numBuildings = count;
    for(int i = 0; i < count; i++){
        float minX = aabbData[i*6 + 0], minY = aabbData[i*6 + 1], minZ = aabbData[i*6 + 2];
        float maxX = aabbData[i*6 + 3], maxY = aabbData[i*6 + 4], maxZ = aabbData[i*6 + 5];
        float cx = (minX + maxX) * 0.5f;
        float cy = (minY + maxY) * 0.5f;
        float cz = (minZ + maxZ) * 0.5f;
        float hx = (maxX - minX) * 0.5f;
        float hy = (maxY - minY) * 0.5f;
        float hz = (maxZ - minZ) * 0.5f;
        buildings[i] = {{cx, cy, cz}, {hx, hy, hz}, 0.40f, 0.38f, 0.34f, false};
    }
    printf("[R26] setMapBuildings: %d AABBs installed\n", count);
}

extern "C" void setLocalPlayerNetCorrection(float x, float y, float z, float yaw, float pitch){
    Player&me=players[localPlayer];
    me.pos.x = x; me.pos.y = y; me.pos.z = z;
    me.yaw = yaw; me.pitch = pitch;
}

// ============================================================
// Render-state population (R15: Three.js bridge)
// Called once per simulation tick. Writes the live game state into the
// flat g_r* arrays that JS reads via Float32Array views into HEAPF32.
// ============================================================
static void populateRenderState(){
    g_rPlayerCount = MAX_PLAYERS;
    for(int i=0;i<MAX_PLAYERS;i++){
        const Player&p=players[i];
        RenderPlayer&r=g_rPlayers[i];
        r.pos[0]=p.pos.x; r.pos[1]=p.pos.y; r.pos[2]=p.pos.z;
        // Three.js 'YXZ' euler order: yaw around Y, pitch around X
        r.rot[0]=p.pitch; r.rot[1]=p.yaw; r.rot[2]=0;
        r.vel[0]=p.vel.x; r.vel[1]=p.vel.y; r.vel[2]=p.vel.z;
        r.health=p.health; r.energy=p.energy;
        r.team=(float)p.team; r.armor=(float)p.armor;
        r.alive=p.alive?1.0f:0.0f;
        r.jetting=p.jetting?1.0f:0.0f;
        r.skiing=p.skiing?1.0f:0.0f;
        r.weaponIdx=(float)p.curWeapon;
        r.carryingFlag=(float)p.carryingFlag;
        r.visible=p.active?1.0f:0.0f;
        r.botRole=p.isBot?(float)p.botRole:-1.0f;
        // R22: spawn protection remaining seconds in reserved[0]
        r.reserved[0] = (g_spawnProtect[i] > gameTime) ? (g_spawnProtect[i] - gameTime) : 0.0f;
    }

    // Projectiles
    g_rProjectileCount = MAX_PROJ;
    for(int i=0;i<MAX_PROJ;i++){
        const Projectile&p=projs[i];
        RenderProjectile&r=g_rProjectiles[i];
        r.pos[0]=p.pos.x; r.pos[1]=p.pos.y; r.pos[2]=p.pos.z;
        r.vel[0]=p.vel.x; r.vel[1]=p.vel.y; r.vel[2]=p.vel.z;
        r.type=(float)p.weapon;
        r.age=p.life;
        r.team=(float)p.ownerTeam;
        r.alive=p.active?1.0f:0.0f;
    }

    // Particles
    g_rParticleCount = MAX_PART;
    for(int i=0;i<MAX_PART;i++){
        const Particle&p=parts[i];
        RenderParticle&r=g_rParticles[i];
        r.pos[0]=p.pos.x; r.pos[1]=p.pos.y; r.pos[2]=p.pos.z;
        r.vel[0]=p.vel.x; r.vel[1]=p.vel.y; r.vel[2]=p.vel.z;
        // Type derived from color (rough heuristic, R18 will use proper type)
        r.type=p.active?(p.r>0.7f&&p.g<0.3f?3.0f:(p.r>0.7f&&p.g>0.5f?0.0f:4.0f)):0.0f;
        r.age=p.active?p.life:0.0f;
    }

    // Flags
    for(int i=0;i<2;i++){
        const Flag&f=flags[i];
        RenderFlag&r=g_rFlags[i];
        r.pos[0]=f.pos.x; r.pos[1]=f.pos.y; r.pos[2]=f.pos.z;
        r.team=(float)f.team;
        r.state=f.atHome?0.0f:(f.carried?1.0f:2.0f);
        r.carrierIdx=(float)f.carrierIdx;
    }
}

// ============================================================
// R15 exports — JS reads these via Module._get*Ptr/Count/Stride
// ============================================================
extern "C" {
    float* getPlayerStatePtr()       { return (float*)g_rPlayers; }
    int    getPlayerStateCount()     { return g_rPlayerCount; }
    int    getPlayerStateStride()    { return sizeof(RenderPlayer)/4; }
    int    getLocalPlayerIdx()       { return g_localPlayerIdx; }

    float* getProjectileStatePtr()   { return (float*)g_rProjectiles; }
    int    getProjectileStateCount() { return g_rProjectileCount; }
    int    getProjectileStateStride(){ return sizeof(RenderProjectile)/4; }

    float* getParticleStatePtr()     { return (float*)g_rParticles; }
    int    getParticleStateCount()   { return g_rParticleCount; }
    int    getParticleStateStride()  { return sizeof(RenderParticle)/4; }

    float* getFlagStatePtr()         { return (float*)g_rFlags; }
    int    getFlagStateCount()       { return 2; }
    int    getFlagStateStride()      { return sizeof(RenderFlag)/4; }

    float* getBuildingPtr()          { return (float*)g_rBuildings; }
    int    getBuildingCount()        { return g_rBuildingCount; }
    int    getBuildingStride()       { return sizeof(RenderBuilding)/4; }

    float* getHeightmapPtr()         { return (float*)RAINDANCE_HEIGHTS; }
    int    getHeightmapCount()       { return RAINDANCE_SIZE*RAINDANCE_SIZE; }
    int    getHeightmapSize()        { return RAINDANCE_SIZE; }
    float  getHeightmapWorldScale()  { return TSCALE; }

    float  getCameraFov()            { return g_fov; }
    int    getMatchState()           { return g_matchState; }
    int    isReady()                 { return g_renderReady; }

    // R31.4: 3P state getter — syncs Three.js camera and mesh visibility to C++ flag
    int    getThirdPerson()    { return thirdPerson ? 1 : 0; }

    // R32.1 O1: APPEND interior-shape AABBs to buildings[] without resetting.
    // Format: 6 floats per AABB — [minX,minY,minZ, maxX,maxY,maxZ] in world space.
    // Called from renderer.js initInteriorShapes() after it loads canonical.json.
    // Unlike setMapBuildings (which replaces), this appends so Raindance's own
    // C++ initBuildings() data (turrets, generators, etc.) is preserved.
    void   appendInteriorShapeAABBs(int count, float* data) {
        if(count <= 0 || !data) return;
        int added = 0;
        for(int i = 0; i < count; i++){
            if(numBuildings >= MAX_BUILDINGS){
                printf("[R32.1] appendInteriorShapeAABBs: MAX_BUILDINGS (%d) reached after %d/%d\n",
                       MAX_BUILDINGS, added, count);
                break;
            }
            float minX = data[i*6+0], minY = data[i*6+1], minZ = data[i*6+2];
            float maxX = data[i*6+3], maxY = data[i*6+4], maxZ = data[i*6+5];
            float cx=(minX+maxX)*0.5f, cy=(minY+maxY)*0.5f, cz=(minZ+maxZ)*0.5f;
            float hx=(maxX-minX)*0.5f, hy=(maxY-minY)*0.5f, hz=(maxZ-minZ)*0.5f;
            buildings[numBuildings++] = {{cx,cy,cz},{hx,hy,hz}, 0.38f,0.36f,0.34f, false};
            added++;
        }
        printf("[R32.1] appendInteriorShapeAABBs: added %d collision boxes (total buildings=%d)\n",
               added, numBuildings);
    }
    // R31.7 C1: aim-convergence point fed from JS ray-march each frame in 3P
    void   setLocalAimPoint3P(float x, float y, float z) {
        aimPoint3P={x,y,z}; hasAimPoint3P=true;
    }

    // R32.68: Append per-triangle collision data for one interior mesh instance.
    // Format: triData = 9 floats per triangle [v0x,v0y,v0z, v1x,v1y,v1z, v2x,v2y,v2z]
    //         all in world space (already transformed by JS).
    // bboxMin/Max = world-space AABB for broadphase.
    void   appendInteriorMeshTris(int numTris, float* triData,
                                   float bmnX, float bmnY, float bmnZ,
                                   float bmxX, float bmxY, float bmxZ) {
        if (numTris <= 0 || !triData) return;
        if (g_numColMeshes >= MAX_COL_MESHES) {
            printf("[R32.68] appendInteriorMeshTris: MAX_COL_MESHES (%d) reached\n", MAX_COL_MESHES);
            return;
        }
        int startIdx = g_numColTris;
        int added = 0;
        for (int i = 0; i < numTris; i++) {
            if (g_numColTris >= MAX_COL_TRIS) {
                printf("[R32.68] appendInteriorMeshTris: MAX_COL_TRIS (%d) reached after %d/%d\n",
                       MAX_COL_TRIS, added, numTris);
                break;
            }
            float* t = triData + i * 9;
            Vec3 v0 = {t[0], t[1], t[2]};
            Vec3 v1 = {t[3], t[4], t[5]};
            Vec3 v2 = {t[6], t[7], t[8]};
            Vec3 e0 = v3sub(v1, v0), e1 = v3sub(v2, v0);
            Vec3 n = v3cross(e0, e1);
            float lenSq = v3dot(n, n);
            if (lenSq < 1e-10f) continue; // degenerate triangle
            float invLen = 1.0f / sqrtf(lenSq);
            n = v3scale(n, invLen);
            g_colTris[g_numColTris++] = {v0, v1, v2, n};
            added++;
        }
        g_colMeshes[g_numColMeshes++] = {
            {bmnX, bmnY, bmnZ}, {bmxX, bmxY, bmxZ},
            startIdx, added
        };
        printf("[R32.68] appendInteriorMeshTris: mesh %d — %d tris (total %d tris, %d meshes)\n",
               g_numColMeshes - 1, added, g_numColTris, g_numColMeshes);
    }

    // D1: Ski HUD exports — queried every frame by index.html ski HUD widget
    int    getPlayerSkiing()   { return players[localPlayer].skiing ? 1 : 0; }
    float  getPlayerSpeed()    { Player&p=players[localPlayer]; return sqrtf(p.vel.x*p.vel.x+p.vel.z*p.vel.z); }
    float  getPlayerSlopeDeg() {
        Player&p=players[localPlayer];
        Vec3 n=getNorm(p.pos.x,p.pos.z);
        float angle=acosf(n.y>1?1:n.y<-1?-1:n.y)*57.2957795f; // deg from horizontal
        // Sign: negative = downhill in velocity direction
        Vec3 vh={p.vel.x,0,p.vel.z};
        float vhLen=sqrtf(vh.x*vh.x+vh.z*vh.z);
        if(vhLen>0.01f){
            float horizDot=(n.x*vh.x+n.z*vh.z)/vhLen;
            return angle*(horizDot>0?-1.0f:1.0f); // going downhill → negative
        }
        return angle; // no velocity: slope magnitude only
    }
    void   setRenderMode(int mode){
        g_renderMode = mode;
        if(mode == 1){
            // Three.js drives RAF; cancel the C++ main loop so we don't double-tick
            emscripten_cancel_main_loop();
            printf("[R15] Render mode = Three.js. C++ main loop cancelled.\n");
        }
    }
    void mainLoop(); // forward decl (defined below; non-static so tick() can call)
    void tick(){ mainLoop(); }
}

// ============================================================
// Main loop
// ============================================================
static float respawnTimer=0;
static int weaponSwitchCooldown=0;

// D3: per-frame physics timing (accumulated for 60-frame window)
static int g_perfFrames=0;
static double g_physicsAccum=0;

extern "C" void mainLoop(){
    double now=emscripten_get_now()/1000.0;
    double t0=emscripten_get_now();  // D3: physics timing start
    float dt=(lastTime>0)?(float)(now-lastTime):TICK;
    if(dt>0.05f)dt=0.05f;
    lastTime=now;gameTime+=dt;frameCount++;

    Player&me=players[localPlayer];

    // --- Input ---
    me.yaw+=mDX*0.003f*g_mouseSensitivity;
    me.pitch-=(g_invertY?-1.0f:1.0f)*mDY*0.003f*g_mouseSensitivity;
    if(me.pitch>1.4f)me.pitch=1.4f;if(me.pitch<-1.4f)me.pitch=-1.4f;
    mDX=mDY=0;

    // Toggle third person (V key)
    static bool vWas=false;
    if(keys[86]&&!vWas)thirdPerson=!thirdPerson;
    vWas=keys[86];

    // Weapon switch (1-5 keys, or mousewheel Q/E)
    if(weaponSwitchCooldown>0)weaponSwitchCooldown--;
    if(weaponSwitchCooldown==0){
        int newWpn=-1;
        if(keys[49])newWpn=WPN_BLASTER;
        if(keys[50])newWpn=WPN_CHAINGUN;
        if(keys[51])newWpn=WPN_DISC;
        if(keys[52])newWpn=WPN_GRENADE_LAUNCHER;
        if(keys[53])newWpn=WPN_PLASMA;
        if(keys[54]&&armorCanUse[me.armor][WPN_MORTAR])newWpn=WPN_MORTAR;
        if(keys[81]){ // Q = prev weapon
            newWpn=me.curWeapon-1;if(newWpn<0)newWpn=WPN_REPAIR;
            while(!armorCanUse[me.armor][newWpn]){newWpn--;if(newWpn<0)newWpn=WPN_REPAIR;}
        }
        if(keys[69]){ // E = next weapon
            newWpn=(me.curWeapon+1)%WPN_COUNT;
            while(!armorCanUse[me.armor][newWpn])newWpn=(newWpn+1)%WPN_COUNT;
        }
        if(newWpn>=0&&armorCanUse[me.armor][newWpn]){me.curWeapon=newWpn;weaponSwitchCooldown=10;}
    }

    // F key — inventory station interaction
    static bool fWas=false;
    if(keys[70]&&!fWas&&me.alive){
        for(int i=0;i<RAINDANCE_STATION_COUNT;i++){
            float sx=RAINDANCE_STATIONS[i].x, sz=-RAINDANCE_STATIONS[i].y, sy=RAINDANCE_STATIONS[i].z;
            int stTeam=(strstr(RAINDANCE_STATIONS[i].team,"team0")?0:1);
            Vec3 spos={sx,sy,sz};
            if((me.pos-spos).lenSq()<16.0f){ // 4m radius
                int genOk=generatorAlive[stTeam]?1:0;
                openStationIdx=i;
                printf("[STATION:%d:%d]\n",i,genOk);
                break;
            }
        }
    }
    fWas=keys[70];

    // Auto-close station if player moved >6m away
    if(openStationIdx>=0&&me.alive){
        float sx=RAINDANCE_STATIONS[openStationIdx].x;
        float sz=-RAINDANCE_STATIONS[openStationIdx].y;
        float sy=RAINDANCE_STATIONS[openStationIdx].z;
        if((me.pos-Vec3(sx,sy,sz)).lenSq()>36.0f){ // 6m radius
            openStationIdx=-1;
            printf("[STATION:CLOSE]\n");
        }
    }

    if(me.alive){
        Vec3 fwd={sinf(me.yaw)*cosf(me.pitch),sinf(me.pitch),-cosf(me.yaw)*cosf(me.pitch)};
        Vec3 right={cosf(me.yaw),0,sinf(me.yaw)};
        Vec3 flatFwd={sinf(me.yaw),0,-cosf(me.yaw)};
        const ArmorData&ad=armors[me.armor];

        Vec3 moveDir={0,0,0};
        if(keys[87]||keys[38])moveDir+=flatFwd;
        if(keys[83]||keys[40])moveDir+=flatFwd*-1;
        if(keys[65]||keys[37])moveDir+=right*-1;
        if(keys[68]||keys[39])moveDir+=right;

        float th=getH(me.pos.x,me.pos.z);
        float groundDist=me.pos.y-th;
        me.onGround=groundDist<2.2f;  // R31: raised to match new clamp floor
        // F2: persist ski state 0.25 s after leaving ground (mogul bounce resilience)
        if(keys[16]){
            if(me.onGround){ me.skiing=true; me.airSkiTimer=0.25f; }
            else if(me.airSkiTimer>0){ me.skiing=true; me.airSkiTimer-=dt; }
            else me.skiing=false;
        }else{ me.skiing=false; me.airSkiTimer=0; }

        // Gravity — Tribes uses ~20 m/s² as force (F=ma), so acceleration = 20
        // Applied as velocity change per frame: v += g * dt
        // Original engine gravity via SimMovement is roughly mass-independent ~20 m/s²
        float gravity = 20.0f; // F1: T1 SimMovement reference (was 25)

        // Ground movement — from playerUpdate.cpp lines 591-608
        if(me.skiing){
            // Skiing: near-zero traction, gravity pulls along slope
            // From playerUpdate.cpp lines 806-819: traction rebuilt from contacts
            // When skiing, traction approaches 0 so ground force can't decelerate
            Vec3 norm=getNorm(me.pos.x,me.pos.z);
            Vec3 gravVec={0,-gravity*dt,0};
            // Slope component of gravity (project gravity onto slope plane)
            Vec3 slopeForce=gravVec-norm*gravVec.dot(norm);
            me.vel+=slopeForce;
            // Minimal air control while skiing
            me.vel+=moveDir*(ad.maxFwdSpeed*0.08f*dt);
            // Very low friction — this is what makes skiing work
            me.vel.x*=0.998f;me.vel.z*=0.998f;
        }else if(me.onGround){
            // Ground: full traction, acceleration-based movement
            // From playerUpdate.cpp: maxAcc = groundForce/mass * traction * timeSlice
            float maxAcc=ad.groundForce/ad.mass*ad.groundTraction*dt;
            if(maxAcc>1.0f)maxAcc=1.0f;
            float targetSpd=moveDir.len()>0.01f?ad.maxFwdSpeed:0;
            Vec3 md=moveDir.normalized();
            me.vel.x+=(md.x*targetSpd-me.vel.x)*maxAcc;
            me.vel.z+=(md.z*targetSpd-me.vel.z)*maxAcc;
            if(me.vel.y<0)me.vel.y=0;
        }else{
            // F3: Airborne — air control capped at maxJetFwdVel so WASD can't
            // accelerate indefinitely in the air (replaces the uncapped add).
            Vec3 md3=moveDir.len()>0.01f?moveDir.normalized():Vec3{0,0,0};
            float curH=sqrtf(me.vel.x*me.vel.x+me.vel.z*me.vel.z);
            if(curH<ad.maxJetFwdVel){
                float airAcc=ad.maxFwdSpeed*0.5f*dt;
                me.vel.x+=md3.x*airAcc;
                me.vel.z+=md3.z*airAcc;
            }
        }

        // Gravity when airborne
        if(!me.onGround)me.vel.y-=gravity*dt;

        // Jetting — from playerUpdate.cpp lines 644-702
        // Jet splits force between lateral (toward input direction) and vertical
        // Split ratio based on current velocity vs maxJetForwardVelocity
        if(g_jetToggle){
            static bool jetKeyWas=false;
            if(keys[32]&&!jetKeyWas)g_jetActive=!g_jetActive;
            jetKeyWas=keys[32];
            if(!me.onGround&&me.energy<ad.minJetEnergy)g_jetActive=false;
            me.jetting=g_jetActive&&me.energy>=ad.minJetEnergy&&!me.onGround;
        }else{
            g_jetActive=false;
            me.jetting=keys[32]&&me.energy>=ad.minJetEnergy&&!me.onGround;
        }
        if(me.jetting){
            me.energy-=ad.jetEnergyDrain/TICK*dt;
            if(me.energy<0)me.energy=0;

            float jetAcc=ad.jetForce/ad.mass*dt;
            // F4: T1 jet-split formula. At max forward speed all jet is horizontal.
            // vertPct = 1 - clamp(forwardDot / maxJetFwdVel, 0, 1)
            if(moveDir.len()>0.01f && me.jumpContact>8){
                Vec3 md=moveDir.normalized();
                float forwardDot=me.vel.x*md.x+me.vel.z*md.z;
                float frac=forwardDot/ad.maxJetFwdVel;
                if(frac<0)frac=0; if(frac>1)frac=1;
                float horizPct=frac;           // at top speed → all horizontal
                float vertPct=1.0f-frac;       // at standstill → all vertical
                me.vel.x+=md.x*horizPct*jetAcc;
                me.vel.z+=md.z*horizPct*jetAcc;
                me.vel.y+=vertPct*jetAcc;
            }else{
                me.vel.y+=jetAcc;
            }
            // Jetpack glow: twin thruster plumes from behind player
            Vec3 jBack=me.pos+Vec3(-sinf(me.yaw)*0.35f,0.7f,cosf(me.yaw)*0.35f);
            float rx=(rand()%100-50)*0.006f,rz=(rand()%100-50)*0.006f;
            spawnPart(jBack,Vec3(rx,-5.0f,rz),1.0f,0.55f,0.08f,0.28f,0.30f); // orange core
            spawnPart(jBack+Vec3(0,-0.2f,0),Vec3(0,-3.5f,0),1.0f,0.85f,0.35f,0.18f,0.22f); // yellow halo
        }else{
            me.energy+=ENERGY_RECHARGE*ad.energyRegenMul*dt;  // F7: per-armor regen rate
            float enCap=ad.maxEnergy*(me.pack==1?1.5f:1.0f);
            if(me.energy>enCap)me.energy=enCap;
        }

        // Repair pack — heal over 10s
        if(me.pack==2&&me.healTimer>0){
            me.healTimer-=dt;
            me.health+=ad.maxDamage*0.1f*dt; // full HP in 10s
            if(me.health>ad.maxDamage)me.health=ad.maxDamage;
        }

        // F5: Jump at full impulse magnitude along surface normal.
        // Previous *0.4f and *0.3f magic scalars cut the impulse too much (~1 m lift).
        // T1 target: Light armor (~2.5 m lift). dv = jumpImpulse/mass along normal.
        if(keys[32]&&me.onGround&&me.jumpContact<8){
            me.jumpContact=8;
            Vec3 jn=getNorm(me.pos.x,me.pos.z);
            float dv=ad.jumpImpulse/ad.mass;
            me.vel.x+=jn.x*dv;
            me.vel.y+=jn.y*dv;
            me.vel.z+=jn.z*dv;
            if(moveDir.len()>0.01f){
                Vec3 md=moveDir.normalized();
                float dot=md.x*jn.x+md.z*jn.z;
                if(dot>0){
                    me.vel.x+=md.x*dot*dv*0.3f;
                    me.vel.z+=md.z*dot*dv*0.3f;
                }
            }
        }
        if(me.onGround)me.jumpContact=0; else if(me.jumpContact<100)me.jumpContact++;

        me.pos+=me.vel*dt;
        th=getH(me.pos.x,me.pos.z);
        if(me.pos.y<th+1.8f){
            // Fall damage
            if(me.vel.y<-25){
                float dmg=(-me.vel.y-25)*ad.damageScale;
                me.health-=dmg;
                if(me.health<=0){me.health=0;me.alive=false;me.deaths++;}
            }
            me.pos.y=th+1.8f;
            if(me.vel.y<0)me.vel.y=0;  // F0: ALWAYS zero downward vel; skiing guard caused tunnel-through
            if(!me.skiing){me.vel.x*=0.9f;me.vel.z*=0.9f;}
        }
        resolvePlayerBuildingCollision(me.pos, me.vel, ad.hitW, ad.hitH);
        resolvePlayerInteriorCollision(me.pos, me.vel, ad.hitW, ad.hitH);
        float we=TSIZE*TSCALE*0.48f; // ~985m from center
        me.pos.x=fmaxf(-we,fminf(we,me.pos.x));
        me.pos.z=fmaxf(-we,fminf(we,me.pos.z));
        me.speed=sqrtf(me.vel.x*me.vel.x+me.vel.z*me.vel.z);

        // Fire
        me.fireCooldown-=dt;
        if(fireDown&&me.fireCooldown<=0&&ptrLocked)fireWeapon(localPlayer);
    }else{
        respawnTimer+=dt;
        g_localRespawnTimer=5.0f-respawnTimer;
        if(respawnTimer>5){respawnPlayer(localPlayer);respawnTimer=0;}
    }

    // Match state machine
    if(g_matchState==0){ // WARMUP
        g_warmupTimer-=dt;
        if(!g_warnedTime[2]&&g_warmupTimer<3){g_warnedTime[2]=true;EM_ASM({if(window.playSoundUI)window.playSoundUI(5);},0);}
        if(g_warmupTimer<=0){
            g_matchState=1;g_roundTimer=(float)g_timeLimit;
            printf("[EVENT] WARMUP COMPLETE — FIGHT!\n");
            EM_ASM({if(window.playSoundUI)window.playSoundUI(6);},0);
        }
    }else if(g_matchState==1){ // IN_PROGRESS
        if(g_timeLimit>0){
            g_roundTimer-=dt;
            if(!g_warnedTime[0]&&g_roundTimer<240){g_warnedTime[0]=true;printf("[EVENT] 4 MINUTES REMAINING\n");}
            if(!g_warnedTime[1]&&g_roundTimer<60){g_warnedTime[1]=true;printf("[EVENT] 1 MINUTE REMAINING\n");}
            if(g_roundTimer<=0){
                g_roundTimer=0;g_matchState=2;
                int w=teamScore[0]>teamScore[1]?0:(teamScore[1]>teamScore[0]?1:-1);
                if(w>=0)printf("[EVENT] === TIME UP — %s WINS! %d-%d ===\n",w==0?"BLOOD EAGLE":"DIAMOND SWORD",teamScore[0],teamScore[1]);
                else printf("[EVENT] === TIME UP — DRAW! %d-%d ===\n",teamScore[0],teamScore[1]);
                EM_ASM({if(window.onMatchEnd)window.onMatchEnd($0,$1,$2);},w,teamScore[0],teamScore[1]);
            }
        }
    }

    // Update bots
    for(int i=0;i<MAX_PLAYERS;i++)if(players[i].active&&players[i].isBot)updateBot(i,dt);
    updateTurrets(dt);
    updateGenerators(dt);

    // Update projectiles
    for(int i=0;i<MAX_PROJ;i++){
        if(!projs[i].active)continue;
        const WeaponData&w=weapons[projs[i].weapon];
        projs[i].vel.y-=w.gravity*dt;

        // Disc acceleration: 65 → 80 m/s terminal velocity (from baseProjData.cs)
        if(projs[i].weapon==WPN_DISC){
            float spd=projs[i].vel.len();
            if(spd<80.0f&&spd>0.1f){
                Vec3 dir=projs[i].vel*(1.0f/spd);
                float accel=5.0f*dt; // acceleration per frame
                projs[i].vel+=dir*accel;
            }
        }

        projs[i].pos+=projs[i].vel*dt;
        projs[i].life-=dt;
        float ph=getH(projs[i].pos.x,projs[i].pos.z);
        bool hitTerrain=projs[i].pos.y<=ph;
        bool hitBuilding=projectileHitsBuilding(projs[i].pos);
        bool expired=projs[i].life<=0;
        bool hitPlayer=false;
        // Check player hits
        if(!hitTerrain&&!hitBuilding&&!expired)for(int j=0;j<MAX_PLAYERS;j++){
            if(!players[j].active||!players[j].alive)continue;
            float d=(players[j].pos+Vec3(0,1.2f,0)-projs[i].pos).lenSq();
            float hitR=armors[players[j].armor].hitW+0.5f;
            if(d<hitR*hitR){
                damagePlayer(j,w.damage,projs[i].ownerTeam);
                // D1 R31.6: when local player is hit, fire damage-source callback
                // so JS can show a directional damage arc pointing at the attacker.
                // Approximate source: walk backwards along projectile velocity 30m.
                if(j==localPlayer){
                    float vx=projs[i].vel.x,vz=projs[i].vel.z;
                    float vl=sqrtf(vx*vx+vz*vz);
                    if(vl>0.01f){
                        float sx=projs[i].pos.x-vx/vl*30.0f;
                        float sz=projs[i].pos.z-vz/vl*30.0f;
                        EM_ASM({if(window.onDamageSource)window.onDamageSource($0,$1);},(double)sx,(double)sz);
                    }
                }
                if(!players[j].alive&&projs[i].ownerTeam!=players[j].team){
                    for(int k=0;k<MAX_PLAYERS;k++)if(players[k].active&&players[k].team==projs[i].ownerTeam){
                        players[k].kills++;players[k].score++;
                        printf("[KILL]%s~%d~%s\n",players[k].name,projs[i].weapon,players[j].name);
                        break;
                    }
                }
                hitPlayer=true;break;
            }
        }
        // Check turret hits (enemy projectiles only)
        if(!hitPlayer&&!hitBuilding&&!hitTerrain&&!expired){
            for(int t=0;t<RAINDANCE_TURRET_COUNT;t++){
                if(!turrets[t].alive||turrets[t].team==projs[i].ownerTeam)continue;
                Vec3&tp=turrets[t].pos;
                if(fabsf(projs[i].pos.x-tp.x)<1.3f&&
                   projs[i].pos.y>tp.y-0.5f&&projs[i].pos.y<tp.y+3.5f&&
                   fabsf(projs[i].pos.z-tp.z)<1.3f){
                    turrets[t].hp-=w.damage*100.0f;
                    if(turrets[t].hp<=0){turrets[t].hp=0;turrets[t].alive=false;
                        printf("[CTF] %s turret #%d destroyed\n",turrets[t].team==0?"RED":"BLUE",t+1);}
                    hitPlayer=true;break; // treat as hit to trigger explosion
                }
            }
            // Check generator hits
            for(int g=0;g<RAINDANCE_GENERATOR_COUNT;g++){
                if(!generators[g].alive||generators[g].team==projs[i].ownerTeam)continue;
                Vec3&gp=generators[g].pos;
                if(fabsf(projs[i].pos.x-gp.x)<1.8f&&
                   projs[i].pos.y>gp.y-0.5f&&projs[i].pos.y<gp.y+2.5f&&
                   fabsf(projs[i].pos.z-gp.z)<1.8f){
                    generators[g].hp-=w.damage*100.0f;
                    if(generators[g].hp<=0){
                        generators[g].hp=0;generators[g].alive=false;
                        generatorAlive[generators[g].team]=false;
                        printf("[CTF] >>> %s GENERATOR DESTROYED — turrets offline <<<\n",
                               generators[g].team==0?"RED":"BLUE");
                        EM_ASM({ if(window.playSoundAt)window.playSoundAt(8,$0,$1,$2); },
                               (int)generators[g].pos.x,(int)generators[g].pos.y,(int)generators[g].pos.z);
                    }
                    hitPlayer=true;break;
                }
            }
        }
        // Grenade bounces off terrain instead of detonating
        if(hitTerrain&&!hitPlayer&&!expired&&!hitBuilding&&projs[i].weapon==WPN_GRENADE_LAUNCHER){
            float hspd=sqrtf(projs[i].vel.x*projs[i].vel.x+projs[i].vel.z*projs[i].vel.z);
            if(hspd>2.0f){
                projs[i].vel.y=fabsf(projs[i].vel.y)*0.4f;
                projs[i].vel.x*=0.75f;projs[i].vel.z*=0.75f;
                projs[i].pos.y=ph+0.1f;
                hitTerrain=false;
            }
        }
        bool hit=hitPlayer||expired||hitBuilding||hitTerrain;
        if(hit){
            if(w.explosionRadius>0){
                spawnBurst(projs[i].pos,30,1.5f,25,1,0.6f,0.1f,0.5f);
                spawnBurst(projs[i].pos,15,1,10,1,0.9f,0.5f,0.3f);
                // Radius damage
                for(int j=0;j<MAX_PLAYERS;j++){
                    if(!players[j].active||!players[j].alive)continue;
                    float d=(players[j].pos-projs[i].pos).len();
                    if(d<w.explosionRadius){
                        float falloff=1.0f-d/w.explosionRadius;
                        damagePlayer(j,w.damage*falloff,projs[i].ownerTeam);
                        // Splash impulse — enables disc jumping / rocket jumping
                        // Kickback 150 for disc, scaled by distance falloff
                        Vec3 pushDir=(players[j].pos-projs[i].pos);
                        if(pushDir.len()<0.1f) pushDir={0,1,0};
                        pushDir=pushDir.normalized();
                        float impulse=w.kickback*falloff/armors[players[j].armor].mass;
                        pushDir=pushDir*impulse*0.15f;
                        pushDir.y+=impulse*0.12f; // extra upward kick for disc jumping
                        players[j].vel+=pushDir;
                    }
                }
            }else{
                spawnBurst(projs[i].pos,5,0.5f,10,w.r,w.g,w.b,0.3f);
            }
            // Positional impact sound
            EM_ASM({ if(window.playSoundAt)window.playSoundAt(4,$0,$1,$2); },
                   (int)projs[i].pos.x,(int)projs[i].pos.y,(int)projs[i].pos.z);
            projs[i].active=false;
        }
    }

    // Update particles
    for(int i=0;i<MAX_PART;i++){
        if(!parts[i].active)continue;
        parts[i].vel.y-=40*dt;
        parts[i].pos+=parts[i].vel*dt;
        parts[i].life-=dt;
        float ph=getH(parts[i].pos.x,parts[i].pos.z);
        if(parts[i].pos.y<ph){parts[i].vel.y*=-0.3f;parts[i].pos.y=ph;}
        if(parts[i].life<=0)parts[i].active=false;
    }

    // CTF logic
    for(int f=0;f<2;f++){
        Flag&fl=flags[f];
        if(!fl.carried&&!fl.atHome){
            fl.dropTimer-=dt;
            if(fl.dropTimer<=0){
                fl.pos=fl.homePos;fl.atHome=true;
                printf("[CTF] %s flag returned to base\n",f==0?"Red":"Blue");
            }
        }
        // Check pickups
        for(int i=0;i<MAX_PLAYERS;i++){
            if(!players[i].active||!players[i].alive||fl.carried)continue;
            if((players[i].pos-fl.pos).lenSq()>16)continue;
            if(players[i].team==f){
                // Touching own flag
                if(!fl.atHome){
                    fl.pos=fl.homePos;fl.atHome=true;
                    players[i].score++;
                    printf("[CTF] %s returned their flag!\n",players[i].name);
                }else if(players[i].carryingFlag>=0){
                    // Capture!
                    int cf=players[i].carryingFlag;
                    flags[cf].carried=false;flags[cf].pos=flags[cf].homePos;flags[cf].atHome=true;
                    players[i].carryingFlag=-1;
                    teamScore[players[i].team]++;
                    players[i].score+=5;
                    printf("[CTF] %s CAPTURED the flag! Score: Red %d - Blue %d\n",
                           players[i].name,teamScore[0],teamScore[1]);
                    if(i==localPlayer)EM_ASM({ if(window.playSoundUI)window.playSoundUI(7); },0);
                    printf("[EVENT] %s CAPS! (%d-%d)\n",players[i].team==0?"RED":"BLUE",teamScore[0],teamScore[1]);
                    if(g_matchState==1&&teamScore[players[i].team]>=g_scoreLimit){
                        g_matchState=2;
                        int w=players[i].team;
                        printf("[EVENT] === %s WINS! %d-%d ===\n",w==0?"BLOOD EAGLE":"DIAMOND SWORD",teamScore[0],teamScore[1]);
                        EM_ASM({if(window.onMatchEnd)window.onMatchEnd($0,$1,$2);},w,teamScore[0],teamScore[1]);
                    }
                }
            }else{
                // Touching enemy flag
                if(players[i].carryingFlag<0){
                    fl.carried=true;fl.carrierIdx=i;fl.atHome=false;
                    players[i].carryingFlag=f;
                    printf("[CTF] %s grabbed the %s flag!\n",players[i].name,f==0?"Red":"Blue");
                    if(i==localPlayer)EM_ASM({ if(window.playSoundUI)window.playSoundUI(6); },0);
                }
            }
        }
        if(fl.carried&&fl.carrierIdx>=0){
            fl.pos=players[fl.carrierIdx].pos+Vec3(0,2,0);
        }
    }

    // R15: populate render-state for JS consumers (always runs, regardless of mode)
    populateRenderState();

    // D3: accumulate physics time and log once per 60 frames (~1 s at 60 fps)
    double t1=emscripten_get_now();
    g_physicsAccum+=(t1-t0);
    g_perfFrames++;
    if(g_perfFrames>=60){
        double avgPhys=g_physicsAccum/60.0;
        double fps=g_perfFrames>0?1000.0/((t1-t0)+0.001):0;
        EM_ASM({
            const renderMs=(window.r3FrameTime||0);
            const fps60=60000.0/$0;
            console.log('[PERF] avg-dt='+fps60.toFixed(1)+'ms physics='+$1.toFixed(2)+'ms render='+renderMs.toFixed(2)+'ms');
        }, g_physicsAccum, avgPhys);
        g_perfFrames=0; g_physicsAccum=0;
    }

    // ============================================================
    // LEGACY RENDERER — SUNSET PLANNED R18.1 (~1 week from R17 cutover).
    // Active only when ?renderer=legacy or g_renderMode==0.
    // All NEW feature work goes to renderer.js (Three.js path).
    // Bug fixes here only if they affect data also exposed to renderer.js.
    // Do NOT add visual quality improvements; R18 cashes in on Three.js.
    // ============================================================
    if(g_renderMode != 0) {
        // Three.js mode: still broadcast HUD + audio state to JS overlays
        broadcastHUD();
        // D2 R31.6: pass skiing state so JS can drive the ski hiss loop
        EM_ASM({ if(window.updateAudio)window.updateAudio($0,$1,$2,$3,$4); },
               me.jetting?1:0, me.onGround?1:0, (int)(me.speed*10), (int)(me.health*1000),
               (me.skiing&&me.alive&&g_matchState==1)?1:0);
        return;
    }
    Vec3 sunDir=Vec3(0.4f,0.8f,0.3f).normalized();
    float skyT=0.5f+me.pitch*0.3f;
    // Sky: spec §2 — horizon #B8C4C8 (0.72,0.77,0.78) to zenith #5A6A7A (0.35,0.42,0.48)
    // Blend based on view pitch: looking up = darker zenith, looking down = lighter horizon
    float skyBlend=0.5f-me.pitch*0.3f;
    skyBlend=fmaxf(0.0f,fminf(1.0f,skyBlend));
    float skyR=0.72f*(1-skyBlend)+0.35f*skyBlend;
    float skyG=0.77f*(1-skyBlend)+0.42f*skyBlend;
    float skyB=0.78f*(1-skyBlend)+0.48f*skyBlend;
    glClearColor(skyR,skyG,skyB,1);
    glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);

    Vec3 fwd={sinf(me.yaw)*cosf(me.pitch),sinf(me.pitch),-cosf(me.yaw)*cosf(me.pitch)};
    Vec3 eye;
    if(thirdPerson){
        // R31.5: closer chase (4m back, 1.6m up) + right-shoulder offset (0.7m)
        Vec3 right={cosf(me.yaw),0,sinf(me.yaw)};
        eye=me.pos+Vec3(0,1.6f,0)-fwd*4.0f+right*0.7f;
    }
    else eye=me.pos+Vec3(0,2.5f,0);
    Mat4 view=Mat4::lookAt(eye,fwd,{0,1,0});
    Mat4 proj=Mat4::perspective(g_fov*DEG2RAD,(float)CANVAS_W/CANVAS_H,1.0f,2000.0f*g_renderDistMul);
    Mat4 vp=proj*view;

    // Terrain
    glUseProgram(tShader);glUniformMatrix4fv(tVPLoc,1,0,vp.m);
    glUniform3f(tSunLoc,sunDir.x,sunDir.y,sunDir.z);
    glUniform3f(tCamPosLoc,eye.x,eye.y,eye.z);
    glBindVertexArray(tVAO);glDrawElements(GL_TRIANGLES,tIdxCount,GL_UNSIGNED_INT,0);

    // Objects (batched: buildings, flags, carried flags)
    oBatch.clear();
    // Base platforms under tower models
    pushBox(flags[0].homePos+Vec3(0,-0.5f,0),Vec3(6,1.5f,6),0.35f,0.33f,0.30f);
    pushBox(flags[1].homePos+Vec3(0,-0.5f,0),Vec3(6,1.5f,6),0.30f,0.33f,0.35f);
    // Mission buildings
    for(int i=0;i<numBuildings;i++){
        const Building& bld=buildings[i];
        pushBox(bld.pos, bld.halfSize, bld.r, bld.g, bld.b);
    }
    // D3 R31.6: Turrets — red pulse when alive so users see active threats.
    // Destroyed turrets stay dim grey. Pulse period ~1.2s, 80% min brightness.
    for(int i=0;i<RAINDANCE_TURRET_COUNT;i++){
        Turret&t=turrets[i];
        float pulse=t.alive?(0.82f+0.18f*sinf(gameTime*5.2f)):1.0f;
        float tr=t.alive?(t.team==0?0.75f:0.15f)*pulse:0.18f;
        float tg=t.alive?0.12f*pulse:0.18f;
        float tb=t.alive?(t.team==0?0.12f:0.75f)*pulse:0.18f;
        pushBox(t.pos,Vec3(1.0f,2.5f,1.0f),tr,tg,tb);
        // Barrel: points in aimYaw direction, tilted down if destroyed
        float bx=t.pos.x+sinf(t.aimYaw)*1.2f;
        float bz=t.pos.z-cosf(t.aimYaw)*1.2f;
        float by=t.pos.y+(t.alive?2.2f:1.5f);
        pushBox({bx,by,bz},Vec3(0.2f,0.2f,0.5f),tr*1.1f,tg*1.1f,tb*1.1f);
    }
    // Generators: amber when alive, dark when destroyed
    for(int i=0;i<RAINDANCE_GENERATOR_COUNT;i++){
        Generator&g=generators[i];
        float gr=g.alive?0.55f:0.15f;
        float gg=g.alive?0.45f:0.15f;
        float gb=g.alive?0.25f:0.15f;
        pushBox(g.pos,Vec3(1.5f,2.0f,1.5f),gr,gg,gb);
    }
    // Flags
    for(int f=0;f<2;f++)if(!flags[f].carried)pushFlag(flags[f].pos,f,gameTime);
    // Players carrying flags -- draw carried flag with batch
    for(int i=0;i<MAX_PLAYERS;i++){
        if(!players[i].active)continue;
        if(i==localPlayer&&!thirdPerson)continue;
        if(players[i].carryingFlag>=0){
            int cf=players[i].carryingFlag;
            pushFlag(players[i].pos+Vec3(0,0,0),cf,gameTime);
        }
    }
    flushObj(vp);

    // --- Render DTS models ---
    // Players: DTS armor with zone coloring, breathing, jetpack glow
    {
        static int s_dtsFrameCount=0;
        if((++s_dtsFrameCount%300)==1){
            int alive=0,drawn=0;
            for(int i=0;i<MAX_PLAYERS;i++){
                if(players[i].active&&players[i].alive)alive++;
                if(players[i].active&&(i!=localPlayer||thirdPerson)&&gpuArmor[players[i].armor].valid)drawn++;
            }
            printf("[DTS] frame=%d shader=%u alive=%d drawable=%d\n",
                   s_dtsFrameCount,dtsShader,alive,drawn);
        }
    }
    for(int i=0;i<MAX_PLAYERS;i++){
        if(!players[i].active)continue;
        if(i==localPlayer&&!thirdPerson)continue;
        const Player& pl = players[i];
        const GPUModel& gm = gpuArmor[pl.armor];

        // Blood Eagle: dark crimson primary, near-black secondary
        // Diamond Sword: navy blue primary, steel grey secondary
        float tr,tg,tb,tr2,tg2,tb2;
        if(pl.team==0){
            tr=0.55f;tg=0.06f;tb=0.06f;   // Blood Eagle crimson
            tr2=0.13f;tg2=0.12f;tb2=0.11f; // dark near-black secondary
        }else{
            tr=0.10f;tg=0.14f;tb=0.52f;   // Diamond Sword navy
            tr2=0.30f;tg2=0.33f;tb2=0.40f; // steel grey secondary
        }
        if(!pl.alive){tr*=0.35f;tg*=0.35f;tb*=0.35f;tr2*=0.35f;tg2*=0.35f;tb2*=0.35f;}
        if(gameTime<g_spawnProtect[i]&&fmodf(gameTime,0.17f)<0.085f){tr=0.4f;tg=0.8f;tb=0.9f;tr2=0.3f;tg2=0.7f;tb2=0.8f;}

        // Breathing animation: 4s cycle, phase-offset per player so they don't sync
        float breathY = sinf(gameTime*1.5f + i*1.1f) * 0.032f;

        // Jetpack glow particles — spawn from jetpack position on player's back
        if(pl.jetting&&pl.alive){
            Vec3 jBack=pl.pos+Vec3(-sinf(pl.yaw)*0.35f,0.7f,cosf(pl.yaw)*0.35f);
            for(int p2=0;p2<2;p2++){
                float rx=((rand()%100)-50)*0.006f, rz=((rand()%100)-50)*0.006f;
                spawnPart(jBack,Vec3(rx,-4.5f,rz),1.0f,0.55f+rx,0.08f,0.3f,0.28f);
            }
        }

        if(gm.valid){
            renderDTSModel(gm, vp, pl.pos, pl.yaw, tr, tg, tb, 1.0f,
                           tr2, tg2, tb2, breathY, eye);
            if(frameCount==1) printf("[RENDER] Player %d using DTS model (armor=%d, scale=%.2f, idxCount=%d)\n", i, pl.armor, gm.scale, gm.indexCount);
        }else{
            oBatch.clear();
            pushPlayerModel(pl.pos, pl.yaw, pl.team, pl.armor, pl.alive);
            flushObj(vp);
            if(frameCount==1) printf("[RENDER] Player %d FALLBACK to boxes (armor=%d, valid=%d)\n", i, pl.armor, gm.valid);
        }
    }

    // Towers at flag bases — neutral grey per spec
    for(int f=0;f<2;f++){
        if(gpuTower.valid){
            renderDTSModel(gpuTower, vp, flags[f].homePos, 0.0f, 0.4f, 0.38f, 0.35f,
                           1.0f, 0.3f,0.28f,0.25f, 0, eye);
        }
    }

    // Projectiles: distinct visual per weapon type
    for(int i=0;i<MAX_PROJ;i++){
        if(!projs[i].active)continue;
        const WeaponData&w=weapons[projs[i].weapon];
        if(projs[i].weapon==WPN_DISC&&gpuDisc.valid){
            renderDTSModel(gpuDisc,vp,projs[i].pos,gameTime*15.0f,1.0f,1.0f,1.0f,
                           1.0f,-1,-1,-1,0,eye);
            spawnPart(projs[i].pos,{0,0,0},0.1f,0.8f,1.0f,0.15f,0.15f); // cyan trail
        }else if(projs[i].weapon==WPN_CHAINGUN){
            oBatch.clear();
            pushDisc(projs[i].pos,0.12f,0,1.0f,1.0f,0.2f); // yellow tracer dot
            flushObj(vp);
        }else if(projs[i].weapon==WPN_PLASMA){
            float jitter=(rand()%100)*0.001f;
            oBatch.clear();
            pushDisc(projs[i].pos,0.45f,gameTime*8,1.0f,0.3f+jitter,0.05f); // red-orange globule
            flushObj(vp);
        }else if(projs[i].weapon==WPN_GRENADE_LAUNCHER){
            float gr=0.35f,gg=0.55f,gb=0.15f;
            if(projs[i].life<0.5f&&fmodf(gameTime,0.2f)<0.1f){gr=0.9f;gg=0.1f;gb=0.1f;} // red blink
            oBatch.clear();
            pushDisc(projs[i].pos,0.32f,0,gr,gg,gb); // dark olive ball
            flushObj(vp);
        }else{
            oBatch.clear();
            pushDisc(projs[i].pos,0.4f,gameTime*15,w.r,w.g,w.b);
            flushObj(vp);
        }
    }

    // Particles (additive blend)
    oBatch.clear();
    for(int i=0;i<MAX_PART;i++){
        if(!parts[i].active)continue;
        float t=parts[i].life/parts[i].maxLife;
        pushDisc(parts[i].pos,parts[i].size,gameTime*3,parts[i].r*t,parts[i].g*t,parts[i].b*t);
    }
    glEnable(GL_BLEND);glBlendFunc(GL_SRC_ALPHA,GL_ONE);glDepthMask(0);
    flushObj(vp,0.7f);
    glDepthMask(1);glDisable(GL_BLEND);

    drawHUD();
    broadcastHUD();
    EM_ASM({ if(window.updateAudio)window.updateAudio($0,$1,$2,$3); },
           me.jetting?1:0, me.onGround?1:0, (int)(me.speed*10), (int)(me.health*1000));

    if(frameCount%1800==1){
        printf("[Game] Score: Red %d - Blue %d | %s: HP=%.0f%% EN=%.0f%% SPD=%.0f WPN=%s\n",
            teamScore[0],teamScore[1],me.name,
            me.health/armors[me.armor].maxDamage*100,
            me.energy/armors[me.armor].maxEnergy*100,
            me.speed,weapons[me.curWeapon].name);
    }
}

// ============================================================
// Init
// ============================================================
int main(){
    printf("=== Starsiege: Tribes — Browser Edition ===\n");
    printf("Darkstar Engine compiled to WebAssembly\n\n");
    printf("Controls:\n");
    printf("  WASD        Move          Q/E    Switch weapon\n");
    printf("  Mouse       Look          1-6    Select weapon\n");
    printf("  Click       Fire          V      Toggle 3rd person\n");
    printf("  Space       Jet/Jump      Shift  Ski\n\n");
    printf("Weapons: 1=Blaster 2=Chaingun 3=Disc 4=Grenade 5=Plasma 6=Mortar(Heavy only)\n");
    printf("Objective: Capture enemy flag, return to your base. First to %d wins!\n\n",g_scoreLimit);

    EmscriptenWebGLContextAttributes a;
    emscripten_webgl_init_context_attributes(&a);
    a.majorVersion=2;a.depth=1;a.antialias=1;
    emscripten_webgl_make_context_current(emscripten_webgl_create_context("#canvas",&a));

    emscripten_set_keydown_callback(EMSCRIPTEN_EVENT_TARGET_DOCUMENT,0,0,onKD);
    emscripten_set_keyup_callback(EMSCRIPTEN_EVENT_TARGET_DOCUMENT,0,0,onKU);
    emscripten_set_mousemove_callback("#canvas",0,0,onMM);
    emscripten_set_mousedown_callback("#canvas",0,0,onMD);
    emscripten_set_mouseup_callback("#canvas",0,0,onMU);
    emscripten_set_pointerlockchange_callback(EMSCRIPTEN_EVENT_TARGET_DOCUMENT,0,0,onPL);

    tShader=linkP(tVS,tFS);tVPLoc=glGetUniformLocation(tShader,"uVP");tSunLoc=glGetUniformLocation(tShader,"uSun");tCamPosLoc=glGetUniformLocation(tShader,"uCamPos");
    oShader=linkP(oVS,oFS);oVPLoc=glGetUniformLocation(oShader,"uVP");oALoc=glGetUniformLocation(oShader,"uA");
    hShader=linkP(hVS,hFS);

    // DTS model shader
    dtsShader=linkP(dtsVS,dtsFS);
    dtsVPLoc=glGetUniformLocation(dtsShader,"uVP");
    dtsModelLoc=glGetUniformLocation(dtsShader,"uModel");
    dtsSunLoc=glGetUniformLocation(dtsShader,"uSun");
    dtsTintLoc=glGetUniformLocation(dtsShader,"uTint");
    dtsTint2Loc=glGetUniformLocation(dtsShader,"uTint2");
    dtsCamPosLoc=glGetUniformLocation(dtsShader,"uCamPos");
    dtsALoc=glGetUniformLocation(dtsShader,"uA");

    glGenVertexArrays(1,&oVAO);glGenBuffers(1,&oVBO);
    glGenVertexArrays(1,&hVAO);glGenBuffers(1,&hVBO);

    genTerrain();buildTerrain();

    // --- Load DTS models from Emscripten virtual filesystem ---
    printf("[DTS] Loading Tribes models...\n");

    // Player armor models
    // DTS models are roughly 2-3 units tall in DTS space.
    // Game player height (hitH) is ~2.3-2.6 units. We scale to match.
    // All armor models need consistent scaling. The DTS packed vertices
    // produce models ~0.8-1.0 units tall. We want them ~2.3-2.6 game units.
    // Use a fixed base scale that makes them player-sized.
    float armorBaseScale = 3.0f;

    if(loadDTS("/assets/tribes/larmor.dts", mdlLightArmor)){
        uploadModel(mdlLightArmor, gpuArmor[ARMOR_LIGHT], armorBaseScale);
        printf("[DTS] Light armor loaded (scale=%.1f)\n", armorBaseScale);
    } else {
        printf("[DTS] WARNING: Could not load larmor.dts, using placeholder\n");
        gpuArmor[ARMOR_LIGHT].valid = false;
    }

    if(loadDTS("/assets/tribes/marmor.dts", mdlMediumArmor)){
        uploadModel(mdlMediumArmor, gpuArmor[ARMOR_MEDIUM], armorBaseScale * 1.1f);
        printf("[DTS] Medium armor loaded\n");
    } else {
        gpuArmor[ARMOR_MEDIUM].valid = false;
    }

    if(loadDTS("/assets/tribes/harmor.DTS", mdlHeavyArmor)){
        uploadModel(mdlHeavyArmor, gpuArmor[ARMOR_HEAVY], armorBaseScale * 1.2f);
        printf("[DTS] Heavy armor loaded\n");
    } else {
        gpuArmor[ARMOR_HEAVY].valid = false;
    }

    // Disc projectile
    if(loadDTS("/assets/tribes/discb.DTS", mdlDisc)){
        float sc = 1.5f;
        uploadModel(mdlDisc, gpuDisc, sc);
        printf("[DTS] Disc loaded (scale=%.3f)\n", sc);
    } else {
        printf("[DTS] WARNING: Could not load discb.DTS, using placeholder\n");
        gpuDisc.valid = false;
    }

    // Tower at flag bases
    if(loadDTS("/assets/tribes/tower.DTS", mdlTower)){
        uploadModel(mdlTower, gpuTower, 8.0f);
        printf("[DTS] Tower loaded\n");
    } else {
        printf("[DTS] WARNING: Could not load tower.DTS, using placeholder\n");
        gpuTower.valid = false;
    }

    // Also load chaingun and grenade models for future use
    {
        LoadedModel mdlTemp;
        if(loadDTS("/assets/tribes/chaingun.DTS", mdlTemp))
            printf("[DTS] Chaingun loaded (%d meshes)\n", (int)mdlTemp.meshes.size());
        if(loadDTS("/assets/tribes/grenade.DTS", mdlTemp))
            printf("[DTS] Grenade loaded (%d meshes)\n", (int)mdlTemp.meshes.size());
    }

    // Free source model data (GPU buffers retain the geometry)
    mdlLightArmor.meshes.clear();
    mdlMediumArmor.meshes.clear();
    mdlHeavyArmor.meshes.clear();
    mdlDisc.meshes.clear();
    mdlTower.meshes.clear();

    printf("[DTS] Model loading complete.\n\n");

    // Place flags at real Raindance positions from mission data
    // Mission coords: Tribes (x, y, z-up) → our world (x=tribes_x, z=-tribes_y, y=height)
    // Flag team0: (-221.8, 21.8, 38.7)  Flag team1: (-379.2, 640.8, 52.8)
    Vec3 flag0World = {RAINDANCE_FLAGS[0].x, 0, -RAINDANCE_FLAGS[0].y};
    flag0World.y = getH(flag0World.x, flag0World.z);
    Vec3 flag1World = {RAINDANCE_FLAGS[1].x, 0, -RAINDANCE_FLAGS[1].y};
    flag1World.y = getH(flag1World.x, flag1World.z);

    printf("[CTF] Flag 0 (Red) at world (%.0f, %.0f, %.0f)\n", flag0World.x, flag0World.y, flag0World.z);
    printf("[CTF] Flag 1 (Blue) at world (%.0f, %.0f, %.0f)\n", flag1World.x, flag1World.y, flag1World.z);

    flags[0]={flag0World,flag0World,0,true,false,-1,0,0};
    flags[1]={flag1World,flag1World,1,true,false,-1,0,0};

    initBuildings();
    initNavGrid();

    // Populate render-state buildings (static, written once)
    g_rBuildingCount = numBuildings;
    for(int i=0;i<numBuildings;i++){
        const Building&b=buildings[i];
        RenderBuilding&r=g_rBuildings[i];
        r.pos[0]=b.pos.x; r.pos[1]=b.pos.y; r.pos[2]=b.pos.z;
        r.halfExtents[0]=b.halfSize.x; r.halfExtents[1]=b.halfSize.y; r.halfExtents[2]=b.halfSize.z;
        r.type = b.isRock ? 5.0f : 0.0f;
        r.team = -1.0f;
        r.alive = 1.0f;
        r.color[0]=b.r; r.color[1]=b.g; r.color[2]=b.b;
    }

    // Init turrets
    for(int i=0;i<RAINDANCE_TURRET_COUNT;i++){
        float wx=RAINDANCE_TURRETS[i].x, wz=-RAINDANCE_TURRETS[i].y, wy=RAINDANCE_TURRETS[i].z;
        int tm=(strstr(RAINDANCE_TURRETS[i].team,"team0")?0:1);
        turrets[i]={{wx,wy,wz},tm,200.0f,0,1.5f,0,-1,true};
    }

    // Init generators
    generatorAlive[0]=generatorAlive[1]=true;
    for(int i=0;i<RAINDANCE_GENERATOR_COUNT;i++){
        float wx=RAINDANCE_GENERATORS[i].x, wz=-RAINDANCE_GENERATORS[i].y, wy=RAINDANCE_GENERATORS[i].z;
        int tm=(strstr(RAINDANCE_GENERATORS[i].team,"team0")?0:1);
        generators[i]={{wx,wy,wz},tm,800.0f,0,true};
    }

    // Init players
    memset(players,0,sizeof(players));

    // Local player (Red team, Light armor)
    players[0].active=true;players[0].isBot=false;players[0].team=0;
    players[0].armor=ARMOR_LIGHT;strcpy(players[0].name,"Player");
    players[0].carryingFlag=-1;
    respawnPlayer(0);

    // Bots
    const char*botNames[]={"Fury","Viper","Storm","Ghost","Blaze","Raptor","Shadow"};
    for(int i=1;i<MAX_PLAYERS;i++){
        players[i].active=true;players[i].isBot=true;
        players[i].team=(i<=3)?0:1; // 4 red (inc player), 4 blue
        players[i].armor=(ArmorType)(i%3);
        players[i].carryingFlag=-1;
        strcpy(players[i].name,botNames[i-1]);
        respawnPlayer(i);
        assignBotRole(i);
        g_botLastPos[i]=players[i].pos;
    }

    memset(projs,0,sizeof(projs));
    memset(parts,0,sizeof(parts));

    glEnable(GL_DEPTH_TEST);glEnable(GL_CULL_FACE);

    printf("[Engine] Ready! Click canvas to play. 4v4 CTF.\n");
    printf("[Teams] Red: Player");
    for(int i=1;i<MAX_PLAYERS;i++)if(players[i].team==0)printf(", %s(%s)",players[i].name,armors[players[i].armor].name);
    printf("\n[Teams] Blue: ");
    bool first=true;
    for(int i=1;i<MAX_PLAYERS;i++)if(players[i].team==1){if(!first)printf(", ");printf("%s(%s)",players[i].name,armors[players[i].armor].name);first=false;}
    printf("\n\n");

    g_renderReady = 1;
    emscripten_set_main_loop(mainLoop,0,1);
    return 0;
}
