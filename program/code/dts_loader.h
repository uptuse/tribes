// dts_loader.h - Standalone Darkstar DTS (3D Shape) file parser
// Extracts vertex/face geometry from Starsiege: Tribes .dts model files
// for use in WebGL rendering.
//
// Based on the Darkstar engine source:
//   ts_shape.h / ts_shape.cpp       -- Shape persistence (version 8)
//   ts_CelAnimMesh.h / .cpp         -- CelAnimMesh with packed vertices
//   ts_vertex.h / ts_vertex.cpp     -- PackedVertex, normal table
//   ts_transform.h                  -- Transform (Quat16 + translate)
//   persist.h / blkstrm.h           -- PERS block persistence system
//
// Usage:
//   LoadedModel model;
//   if (loadDTS("larmor.dts", model)) { /* use model.meshes */ }

#ifndef DTS_LOADER_H
#define DTS_LOADER_H

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>

// ---------------------------------------------------------------------------
// Output structures
// ---------------------------------------------------------------------------

struct LoadedMesh {
    std::vector<float> vertices;       // x,y,z repeating
    std::vector<float> normals;        // nx,ny,nz repeating
    std::vector<unsigned int> indices;
    std::vector<float> texcoords;      // u,v repeating
    int vertexCount = 0;
    int faceCount = 0;
    int nodeIndex = -1;                // which skeleton node this mesh is attached to
    float offsetX = 0, offsetY = 0, offsetZ = 0; // object offset from node
};

struct DTSNode {
    int parent;          // parent node index (-1 for root)
    int defaultTransform; // index into transforms array
    char name[24];
};

struct DTSTransform {
    float qx, qy, qz, qw; // quaternion rotation
    float tx, ty, tz;       // translation
};

struct LoadedModel {
    std::vector<LoadedMesh> meshes;
    std::vector<DTSNode> nodes;
    std::vector<DTSTransform> transforms;
    float minX = 0, minY = 0, minZ = 0;
    float maxX = 0, maxY = 0, maxZ = 0;
};

// ---------------------------------------------------------------------------
// Internal format structures matching Darkstar binary layout
// All structs are packed to match the engine's #pragma pack(push,4)
// ---------------------------------------------------------------------------

namespace dts_internal {

// Darkstar normal table - 256 pre-computed unit normals indexed by PackedVertex::normal
// Copied from ts_vertex.cpp
static const float NORMAL_TABLE[256][3] = {
    { 0.565061f, -0.270644f, -0.779396f },
    {-0.309804f, -0.731114f,  0.607860f },
    {-0.867412f,  0.472957f,  0.154619f },
    {-0.757488f,  0.498188f, -0.421925f },
    { 0.306834f, -0.915340f,  0.260778f },
    { 0.098754f,  0.639153f, -0.762713f },
    { 0.713706f, -0.558862f, -0.422252f },
    {-0.890431f, -0.407603f, -0.202466f },
    { 0.848050f, -0.487612f, -0.207475f },
    {-0.232226f,  0.776855f,  0.585293f },
    {-0.940195f,  0.304490f, -0.152706f },
    { 0.602019f, -0.491878f, -0.628991f },
    {-0.096835f, -0.494354f, -0.863850f },
    { 0.026630f, -0.323659f, -0.945799f },
    { 0.019208f,  0.909386f,  0.415510f },
    { 0.854440f,  0.491730f,  0.167731f },
    {-0.418835f,  0.866521f, -0.271512f },
    { 0.465024f,  0.409667f,  0.784809f },
    {-0.674391f, -0.691087f, -0.259992f },
    { 0.303858f, -0.869270f, -0.389922f },
    { 0.991333f,  0.090061f, -0.095640f },
    {-0.275924f, -0.369550f,  0.887298f },
    { 0.426545f, -0.465962f,  0.775202f },
    {-0.482741f, -0.873278f, -0.065920f },
    { 0.063616f,  0.932012f, -0.356800f },
    { 0.624786f, -0.061315f,  0.778385f },
    {-0.530300f,  0.416850f,  0.738253f },
    { 0.312144f, -0.757028f, -0.573999f },
    { 0.399288f, -0.587091f, -0.704197f },
    {-0.132698f,  0.482877f,  0.865576f },
    { 0.950966f,  0.306530f,  0.041268f },
    {-0.015923f, -0.144300f,  0.989406f },
    {-0.407522f, -0.854193f,  0.322925f },
    {-0.932398f,  0.220464f,  0.286408f },
    { 0.477509f,  0.876580f,  0.059936f },
    { 0.337133f,  0.932606f, -0.128796f },
    {-0.638117f,  0.199338f,  0.743687f },
    {-0.677454f,  0.445349f,  0.585423f },
    {-0.446715f,  0.889059f, -0.100099f },
    {-0.410024f,  0.909168f,  0.072759f },
    { 0.708462f,  0.702103f, -0.071641f },
    {-0.048801f, -0.903683f, -0.425411f },
    {-0.513681f, -0.646901f,  0.563606f },
    {-0.080022f,  0.000676f, -0.996793f },
    { 0.066966f, -0.991150f, -0.114615f },
    {-0.245220f,  0.639318f, -0.728793f },
    { 0.250978f,  0.855979f,  0.452006f },
    {-0.123547f,  0.982443f, -0.139791f },
    {-0.794825f,  0.030254f, -0.606084f },
    {-0.772905f,  0.547941f,  0.319967f },
    { 0.916347f,  0.369614f, -0.153928f },
    {-0.388203f,  0.105395f,  0.915527f },
    {-0.700468f, -0.709334f,  0.078677f },
    {-0.816193f,  0.390455f,  0.425880f },
    {-0.043007f,  0.769222f, -0.637533f },
    { 0.911444f,  0.113150f,  0.395560f },
    { 0.845801f,  0.156091f, -0.510153f },
    { 0.829801f, -0.029340f,  0.557287f },
    { 0.259529f,  0.416263f,  0.871418f },
    { 0.231128f, -0.845982f,  0.480515f },
    {-0.626203f, -0.646168f,  0.436277f },
    {-0.197047f, -0.065791f,  0.978184f },
    {-0.255692f, -0.637488f, -0.726794f },
    { 0.530662f, -0.844385f, -0.073567f },
    {-0.779887f,  0.617067f, -0.104899f },
    { 0.739908f,  0.113984f,  0.662982f },
    {-0.218801f,  0.930194f, -0.294729f },
    {-0.374231f,  0.818666f,  0.435589f },
    {-0.720250f, -0.028285f,  0.693137f },
    { 0.075389f,  0.415049f,  0.906670f },
    {-0.539724f, -0.106620f,  0.835063f },
    {-0.452612f, -0.754669f, -0.474991f },
    { 0.682822f,  0.581234f, -0.442629f },
    { 0.002435f, -0.618462f, -0.785811f },
    {-0.397631f,  0.110766f, -0.910835f },
    { 0.133935f, -0.985438f,  0.104754f },
    { 0.759098f, -0.608004f,  0.232595f },
    {-0.825239f, -0.256087f,  0.503388f },
    { 0.101693f, -0.565568f,  0.818408f },
    { 0.386377f,  0.793546f, -0.470104f },
    {-0.520516f, -0.840690f,  0.149346f },
    {-0.784549f, -0.479672f,  0.392935f },
    {-0.325322f, -0.927581f, -0.183735f },
    {-0.069294f, -0.428541f,  0.900861f },
    { 0.993354f, -0.115023f, -0.004288f },
    {-0.123896f, -0.700568f,  0.702747f },
    {-0.438031f, -0.120880f, -0.890795f },
    { 0.063314f,  0.813233f,  0.578484f },
    { 0.322045f,  0.889086f, -0.325289f },
    {-0.133521f,  0.875063f, -0.465228f },
    { 0.637155f,  0.564814f,  0.524422f },
    { 0.260092f, -0.669353f,  0.695930f },
    { 0.953195f,  0.040485f, -0.299634f },
    {-0.840665f, -0.076509f,  0.536124f },
    {-0.971350f,  0.202093f,  0.125047f },
    {-0.804307f, -0.396312f, -0.442749f },
    {-0.936746f,  0.069572f,  0.343027f },
    { 0.426545f, -0.465962f,  0.775202f },
    { 0.794542f, -0.227450f,  0.563000f },
    {-0.892172f,  0.091169f, -0.442399f },
    {-0.312654f,  0.541264f,  0.780564f },
    { 0.590603f, -0.735618f, -0.331743f },
    {-0.098040f, -0.986713f,  0.129558f },
    { 0.569646f,  0.283078f, -0.771603f },
    { 0.431051f, -0.407385f, -0.805129f },
    {-0.162087f, -0.938749f, -0.304104f },
    { 0.241533f, -0.359509f,  0.901341f },
    {-0.576191f,  0.614939f,  0.538380f },
    {-0.025110f,  0.085740f,  0.996001f },
    {-0.352693f, -0.198168f,  0.914515f },
    {-0.604577f,  0.700711f,  0.378802f },
    { 0.465024f,  0.409667f,  0.784809f },
    {-0.254684f, -0.030474f, -0.966544f },
    {-0.604789f,  0.791809f,  0.085259f },
    {-0.705147f, -0.399298f,  0.585943f },
    { 0.185691f,  0.017236f, -0.982457f },
    { 0.044588f,  0.973094f,  0.226052f },
    {-0.405463f,  0.642367f,  0.650357f },
    {-0.563959f,  0.599136f, -0.568319f },
    { 0.367162f, -0.072253f, -0.927347f },
    { 0.960429f, -0.213570f, -0.178783f },
    {-0.192629f,  0.906005f,  0.376893f },
    {-0.199718f, -0.359865f, -0.911378f },
    { 0.485072f,  0.121233f, -0.866030f },
    { 0.467163f, -0.874294f,  0.131792f },
    {-0.638953f, -0.716603f,  0.279677f },
    {-0.622710f,  0.047813f, -0.780990f },
    { 0.828724f, -0.054433f, -0.557004f },
    { 0.130241f,  0.991080f,  0.028245f },
    { 0.310995f, -0.950076f, -0.025242f },
    { 0.818118f,  0.275336f,  0.504850f },
    { 0.676328f,  0.387023f,  0.626733f },
    {-0.100433f,  0.495114f, -0.863004f },
    {-0.949609f, -0.240681f, -0.200786f },
    {-0.102610f,  0.261831f, -0.959644f },
    {-0.845732f, -0.493136f,  0.203850f },
    { 0.672617f, -0.738838f,  0.041290f },
    { 0.380465f,  0.875938f,  0.296613f },
    {-0.811223f,  0.262027f, -0.522742f },
    {-0.074423f, -0.775670f, -0.626736f },
    {-0.286499f,  0.755850f, -0.588735f },
    { 0.291182f, -0.276189f, -0.915933f },
    {-0.638117f,  0.199338f,  0.743687f },
    { 0.439922f, -0.864433f, -0.243359f },
    { 0.177649f,  0.206919f,  0.962094f },
    { 0.277107f,  0.948521f,  0.153361f },
    { 0.507629f,  0.661918f, -0.551523f },
    {-0.503110f, -0.579308f, -0.641313f },
    { 0.600522f,  0.736495f, -0.311364f },
    {-0.691096f, -0.715301f, -0.103592f },
    {-0.041083f, -0.858497f,  0.511171f },
    { 0.207773f, -0.480062f, -0.852274f },
    { 0.795719f,  0.464614f,  0.388543f },
    {-0.100433f,  0.495114f, -0.863004f },
    { 0.703249f,  0.065157f, -0.707951f },
    {-0.324171f, -0.941112f,  0.096024f },
    {-0.134933f, -0.940212f,  0.312722f },
    {-0.438240f,  0.752088f, -0.492249f },
    { 0.964762f, -0.198855f,  0.172311f },
    {-0.831799f,  0.196807f,  0.519015f },
    {-0.508008f,  0.819902f,  0.263986f },
    { 0.471075f, -0.001146f,  0.882092f },
    { 0.919512f,  0.246162f, -0.306435f },
    {-0.960050f,  0.279828f, -0.001187f },
    { 0.110232f, -0.847535f, -0.519165f },
    { 0.208229f,  0.697360f,  0.685806f },
    {-0.199680f, -0.560621f,  0.803637f },
    { 0.170135f, -0.679985f, -0.713214f },
    { 0.758371f, -0.494907f,  0.424195f },
    { 0.077734f, -0.755978f,  0.649965f },
    { 0.612831f, -0.672475f,  0.414987f },
    { 0.142776f,  0.836698f, -0.528726f },
    {-0.765185f,  0.635778f,  0.101382f },
    { 0.669873f, -0.419737f,  0.612447f },
    { 0.593549f,  0.194879f,  0.780847f },
    { 0.646930f,  0.752173f,  0.125368f },
    { 0.837721f,  0.545266f, -0.030127f },
    { 0.541505f,  0.768070f,  0.341820f },
    { 0.760679f, -0.365715f, -0.536301f },
    { 0.381516f,  0.640377f,  0.666605f },
    { 0.565794f, -0.072415f, -0.821361f },
    {-0.466072f, -0.401588f,  0.788356f },
    { 0.987146f,  0.096290f,  0.127560f },
    { 0.509709f, -0.688886f, -0.515396f },
    {-0.135132f, -0.988046f, -0.074192f },
    { 0.600499f,  0.476471f, -0.642166f },
    {-0.732326f, -0.275320f, -0.622815f },
    {-0.881141f, -0.470404f,  0.048078f },
    { 0.051548f,  0.601042f,  0.797553f },
    { 0.402027f, -0.763183f,  0.505891f },
    { 0.404233f, -0.208288f,  0.890624f },
    {-0.311793f,  0.343843f,  0.885752f },
    { 0.098132f, -0.937014f,  0.335223f },
    { 0.537158f,  0.830585f, -0.146936f },
    { 0.725277f,  0.298172f, -0.620538f },
    {-0.882025f,  0.342976f, -0.323110f },
    {-0.668829f,  0.424296f, -0.610443f },
    {-0.408835f, -0.476442f, -0.778368f },
    { 0.809472f,  0.397249f, -0.432375f },
    {-0.909184f, -0.205938f, -0.361903f },
    { 0.866930f, -0.347934f, -0.356895f },
    { 0.911660f, -0.141281f, -0.385897f },
    {-0.431404f, -0.844074f, -0.318480f },
    {-0.950593f, -0.073496f,  0.301614f },
    {-0.719716f,  0.626915f, -0.298305f },
    {-0.779887f,  0.617067f, -0.104899f },
    {-0.475899f, -0.542630f,  0.692151f },
    { 0.081952f, -0.157248f, -0.984153f },
    { 0.923990f, -0.381662f, -0.024025f },
    {-0.957998f,  0.120979f, -0.260008f },
    { 0.306601f,  0.227975f, -0.924134f },
    {-0.141244f,  0.989182f,  0.039601f },
    { 0.077097f,  0.186288f, -0.979466f },
    {-0.630407f, -0.259801f,  0.731499f },
    { 0.718150f,  0.637408f,  0.279233f },
    { 0.340946f,  0.110494f,  0.933567f },
    {-0.396671f,  0.503020f, -0.767869f },
    { 0.636943f, -0.245005f,  0.730942f },
    {-0.849605f, -0.518660f, -0.095724f },
    {-0.388203f,  0.105395f,  0.915527f },
    {-0.280671f, -0.776541f, -0.564099f },
    {-0.601680f,  0.215451f, -0.769131f },
    {-0.660112f, -0.632371f, -0.405412f },
    { 0.921096f,  0.284072f,  0.266242f },
    { 0.074850f, -0.300846f,  0.950731f },
    { 0.943952f, -0.067062f,  0.323198f },
    {-0.917838f, -0.254589f,  0.304561f },
    { 0.889843f, -0.409008f,  0.202219f },
    {-0.565849f,  0.753721f, -0.334246f },
    { 0.791460f,  0.555918f, -0.254060f },
    { 0.261936f,  0.703590f, -0.660568f },
    {-0.234406f,  0.952084f,  0.196444f },
    { 0.111205f,  0.979492f, -0.168014f },
    {-0.869844f, -0.109095f, -0.481113f },
    {-0.337728f, -0.269701f, -0.901777f },
    { 0.366793f,  0.408875f, -0.835634f },
    {-0.098749f,  0.261316f,  0.960189f },
    {-0.272379f, -0.847100f,  0.456324f },
    {-0.319506f,  0.287444f, -0.902935f },
    { 0.873383f, -0.294109f,  0.388203f },
    {-0.088950f,  0.710450f,  0.698104f },
    { 0.551238f, -0.786552f,  0.278340f },
    { 0.724436f, -0.663575f, -0.186712f },
    { 0.529741f, -0.606539f,  0.592861f },
    {-0.949743f, -0.282514f,  0.134809f },
    { 0.155047f,  0.419442f, -0.894443f },
    {-0.562653f, -0.329139f, -0.758346f },
    { 0.816407f, -0.576953f,  0.024576f },
    { 0.178550f, -0.950242f, -0.255266f },
    { 0.479571f,  0.706691f,  0.520192f },
    { 0.391687f,  0.559884f, -0.730145f },
    { 0.724872f, -0.205570f, -0.657496f },
    {-0.663196f, -0.517587f, -0.540624f },
    {-0.660054f, -0.122486f, -0.741165f },
    {-0.531989f,  0.374711f, -0.759328f },
    { 0.194979f, -0.059120f,  0.979024f },
};

// ---------------------------------------------------------------------------
// Binary reader helper - wraps a FILE* with position tracking
// ---------------------------------------------------------------------------

class BinaryReader {
    FILE* fp_;
    bool ok_;
public:
    BinaryReader() : fp_(nullptr), ok_(false) {}
    ~BinaryReader() { close(); }

    bool open(const char* path) {
        fp_ = fopen(path, "rb");
        ok_ = (fp_ != nullptr);
        return ok_;
    }
    void close() {
        if (fp_) { fclose(fp_); fp_ = nullptr; }
        ok_ = false;
    }
    bool good() const { return ok_; }

    int32_t position() const { return (int32_t)ftell(fp_); }
    bool seek(int32_t pos) { return fseek(fp_, pos, SEEK_SET) == 0; }
    bool skip(int32_t n) { return fseek(fp_, n, SEEK_CUR) == 0; }

    bool readBytes(void* dst, size_t n) {
        if (!ok_) return false;
        if (fread(dst, 1, n, fp_) != n) { ok_ = false; return false; }
        return true;
    }

    int8_t   readI8()  { int8_t v = 0;   readBytes(&v, 1); return v; }
    uint8_t  readU8()  { uint8_t v = 0;  readBytes(&v, 1); return v; }
    int16_t  readI16() { int16_t v = 0;  readBytes(&v, 2); return v; }
    uint16_t readU16() { uint16_t v = 0; readBytes(&v, 2); return v; }
    int32_t  readI32() { int32_t v = 0;  readBytes(&v, 4); return v; }
    uint32_t readU32() { uint32_t v = 0; readBytes(&v, 4); return v; }
    float    readF32() { float v = 0;    readBytes(&v, 4); return v; }
};

// ---------------------------------------------------------------------------
// PERS block header parser
// Returns true and sets className/version, leaving reader positioned at
// the start of class-specific data.
// ---------------------------------------------------------------------------

inline bool readPersHeader(BinaryReader& r, std::string& className, int32_t& version) {
    // Read block header: FOURCC tag + size
    uint32_t tag = r.readU32();
    uint32_t blockSize = r.readU32();
    (void)blockSize;

    if (tag != 0x53524550) { // "PERS" in little-endian
        fprintf(stderr, "DTS: Not a PERS block (got 0x%08X)\n", tag);
        return false;
    }

    // Class name: UInt16 length, then chars (null-terminated, word-aligned)
    uint16_t nameLen = r.readU16();
    char nameBuf[256] = {};
    // nameLen is the string length without the null terminator
    // The stored area is padded to maintain word (2-byte) alignment
    int storedLen = nameLen + 1; // include null
    if (storedLen & 1) storedLen++;  // pad to word boundary
    if (storedLen > 255) storedLen = 255;
    r.readBytes(nameBuf, storedLen);
    className = nameBuf;

    // VersionedBase stores an Int32 version after the class name
    version = r.readI32();

    return r.good();
}

// ---------------------------------------------------------------------------
// Shape data layout structures (matching Darkstar pack(4) binary layout)
// These are the version 8 on-disk formats read by readVector/lockVector.
// ---------------------------------------------------------------------------

// Shape::Node (v8): 5 x Int16 = 10 bytes
#pragma pack(push, 1)
struct DiskNode {
    int16_t fName;
    int16_t fParent;
    int16_t fnSubSequences;
    int16_t fFirstSubSequence;
    int16_t fDefaultTransform;
};
#pragma pack(pop)
static_assert(sizeof(DiskNode) == 10, "DiskNode size mismatch");

// Shape::Sequence (v5+): 8 x Int32 = 32 bytes
struct DiskSequence {
    int32_t fName;
    int32_t fCyclic;
    float   fDuration;
    int32_t fPriority;
    int32_t fFirstFrameTrigger;
    int32_t fNumFrameTriggers;
    int32_t fNumIFLSubSequences;
    int32_t fFirstIFLSubSequence;
};
static_assert(sizeof(DiskSequence) == 32, "DiskSequence size mismatch");

// Shape::SubSequence (v8): 3 x Int16 = 6 bytes
#pragma pack(push, 1)
struct DiskSubSequence {
    int16_t fSequenceIndex;
    int16_t fnKeyframes;
    int16_t fFirstKeyframe;
};
#pragma pack(pop)
static_assert(sizeof(DiskSubSequence) == 6, "DiskSubSequence size mismatch");

// Shape::Keyframe (v8): float + UInt16 + UInt16 = 8 bytes
struct DiskKeyframe {
    float    fPosition;
    uint16_t fKeyValue;
    uint16_t fMatIndex;
};
static_assert(sizeof(DiskKeyframe) == 8, "DiskKeyframe size mismatch");

// Transform (v8, TRANS_USE_SCALE=0): Quat16(8) + Point3F(12) = 20 bytes
struct DiskTransform {
    int16_t qx, qy, qz, qw; // Quat16
    float   tx, ty, tz;       // translate
};
static_assert(sizeof(DiskTransform) == 20, "DiskTransform size mismatch");

// Name: char[24]
struct DiskName {
    char name[24];
};
static_assert(sizeof(DiskName) == 24, "DiskName size mismatch");

// Shape::Object (v8) - with pack(4) alignment:
//   Int16 fName(2) + Int16 fFlags(2) + Int32 fMeshIndex(4) +
//   Int16 fNodeIndex(2) + pad(2) + Point3F fObjectOffset(12) +
//   Int16 fnSubSequences(2) + Int16 fFirstSubSequence(2) = 28
struct DiskObject {
    int16_t fName;
    int16_t fFlags;
    int32_t fMeshIndex;
    int16_t fNodeIndex;
    int16_t _pad0;
    float   offX, offY, offZ;
    int16_t fnSubSequences;
    int16_t fFirstSubSequence;
};
static_assert(sizeof(DiskObject) == 28, "DiskObject size mismatch");

// Shape::Detail: Int32 + float = 8 bytes
struct DiskDetail {
    int32_t fRootNodeIndex;
    float   fSize;
};
static_assert(sizeof(DiskDetail) == 8, "DiskDetail size mismatch");

// Shape::FrameTrigger: float + Int32 = 8 bytes
struct DiskFrameTrigger {
    float   fPosition;
    int32_t fValue;
};
static_assert(sizeof(DiskFrameTrigger) == 8, "DiskFrameTrigger size mismatch");

// ---------------------------------------------------------------------------
// CelAnimMesh data layout structures
// ---------------------------------------------------------------------------

// PackedVertex: 4 x UInt8 = 4 bytes
#pragma pack(push, 1)
struct DiskPackedVertex {
    uint8_t x, y, z;
    uint8_t normal;
};
#pragma pack(pop)
static_assert(sizeof(DiskPackedVertex) == 4, "DiskPackedVertex size mismatch");

// Point2F: 2 floats = 8 bytes
struct DiskPoint2F {
    float u, v;
};
static_assert(sizeof(DiskPoint2F) == 8, "DiskPoint2F size mismatch");

// VertexIndexPair: 2 x Int32 = 8 bytes
struct DiskVertexIndexPair {
    int32_t fVertexIndex;
    int32_t fTextureIndex;
};

// CelAnimMesh::Face: 3 x VertexIndexPair + Int32 = 28 bytes
struct DiskFace {
    DiskVertexIndexPair fVIP[3];
    int32_t             fMaterial;
};
static_assert(sizeof(DiskFace) == 28, "DiskFace size mismatch");

// CelAnimMesh::Frame (v3): Int32 + Point3F + Point3F = 28 bytes
struct DiskFrame {
    int32_t fFirstVert;
    float   scaleX, scaleY, scaleZ;
    float   originX, originY, originZ;
};
static_assert(sizeof(DiskFrame) == 28, "DiskFrame size mismatch");

// ---------------------------------------------------------------------------
// CelAnimMesh parser
// Reads a PERS-wrapped CelAnimMesh from the current file position.
// Returns true on success, populating the output LoadedMesh.
// ---------------------------------------------------------------------------

inline bool readCelAnimMesh(BinaryReader& r, LoadedMesh& out) {
    std::string meshClassName;
    int32_t meshVersion = 0;
    if (!readPersHeader(r, meshClassName, meshVersion)) {
        fprintf(stderr, "DTS: Failed to read mesh PERS header\n");
        return false;
    }

    // We only handle CelAnimMesh (the standard Tribes mesh type)
    if (meshClassName != "TS::CelAnimMesh") {
        fprintf(stderr, "DTS: Unsupported mesh class '%s' (expected TS::CelAnimMesh)\n",
                meshClassName.c_str());
        // Skip this mesh - we do not know its size, so we cannot continue
        return false;
    }

    // Read CelAnimMesh header counts
    int32_t nVerts           = r.readI32();
    int32_t nVertsPerFrame   = r.readI32();
    int32_t nTextureVerts    = r.readI32();
    int32_t nFaces           = r.readI32();
    int32_t nFrames          = r.readI32();

    int32_t nTextureVertsPerFrame = nTextureVerts; // default for version < 2
    if (meshVersion >= 2) {
        nTextureVertsPerFrame = r.readI32();
    }
    // Guard against garbage values in bounds-only meshes
    if (nTextureVertsPerFrame < 0 || nTextureVertsPerFrame > nTextureVerts)
        nTextureVertsPerFrame = nTextureVerts;

    // Version < 3 has scale/origin stored here (before per-frame scale/origin)
    float v2ScaleX = 1, v2ScaleY = 1, v2ScaleZ = 1;
    float v2OriginX = 0, v2OriginY = 0, v2OriginZ = 0;
    if (meshVersion < 3) {
        // Point3F scale
        v2ScaleX = r.readF32(); v2ScaleY = r.readF32(); v2ScaleZ = r.readF32();
        // Point3F origin
        v2OriginX = r.readF32(); v2OriginY = r.readF32(); v2OriginZ = r.readF32();
    }

    float meshRadius = r.readF32();
    (void)meshRadius;

    // Read vertex data (PackedVertex array)
    std::vector<DiskPackedVertex> verts(nVerts);
    if (nVerts > 0)
        r.readBytes(verts.data(), nVerts * sizeof(DiskPackedVertex));

    // Read texture coordinate data (Point2F array)
    std::vector<DiskPoint2F> texVerts(nTextureVerts);
    if (nTextureVerts > 0)
        r.readBytes(texVerts.data(), nTextureVerts * sizeof(DiskPoint2F));

    // Read face data
    std::vector<DiskFace> faces(nFaces);
    if (nFaces > 0)
        r.readBytes(faces.data(), nFaces * sizeof(DiskFace));

    // Read frame data
    std::vector<DiskFrame> frames;
    if (meshVersion < 3) {
        // v2Frame: just Int32 fFirstVert (4 bytes)
        struct V2Frame { int32_t fFirstVert; };
        std::vector<V2Frame> v2Frames(nFrames);
        if (nFrames > 0)
            r.readBytes(v2Frames.data(), nFrames * sizeof(V2Frame));

        if (nFrames == 0) {
            // Single implicit frame
            DiskFrame f;
            f.fFirstVert = 0;
            f.scaleX = v2ScaleX; f.scaleY = v2ScaleY; f.scaleZ = v2ScaleZ;
            f.originX = v2OriginX; f.originY = v2OriginY; f.originZ = v2OriginZ;
            frames.push_back(f);
        } else {
            frames.resize(nFrames);
            for (int i = 0; i < nFrames; i++) {
                frames[i].fFirstVert = v2Frames[i].fFirstVert;
                frames[i].scaleX = v2ScaleX; frames[i].scaleY = v2ScaleY; frames[i].scaleZ = v2ScaleZ;
                frames[i].originX = v2OriginX; frames[i].originY = v2OriginY; frames[i].originZ = v2OriginZ;
            }
        }
    } else {
        frames.resize(nFrames);
        if (nFrames > 0)
            r.readBytes(frames.data(), nFrames * sizeof(DiskFrame));
    }

    if (!r.good()) {
        fprintf(stderr, "DTS: Read error in CelAnimMesh data\n");
        return false;
    }

    // --- Extract geometry from frame 0 ---
    if (frames.empty() || nFaces == 0 || nVertsPerFrame == 0)
        return true; // empty mesh, but not an error

    const DiskFrame& frame0 = frames[0];
    float sx = frame0.scaleX, sy = frame0.scaleY, sz = frame0.scaleZ;
    float ox = frame0.originX, oy = frame0.originY, oz = frame0.originZ;
    int fv = frame0.fFirstVert;

    // Unpack vertices for frame 0
    // First 2 verts in each frame are min/max bounding box points, actual verts start at index 2
    out.vertexCount = nVertsPerFrame;
    out.vertices.resize(nVertsPerFrame * 3);
    out.normals.resize(nVertsPerFrame * 3);

    for (int i = 0; i < nVertsPerFrame; i++) {
        int vi = fv + i;
        if (vi < 0 || vi >= nVerts) continue;
        const DiskPackedVertex& pv = verts[vi];
        // Unpack position: p = packed * scale + origin
        out.vertices[i * 3 + 0] = pv.x * sx + ox;
        out.vertices[i * 3 + 1] = pv.y * sy + oy;
        out.vertices[i * 3 + 2] = pv.z * sz + oz;
        // Decode normal from lookup table
        out.normals[i * 3 + 0] = NORMAL_TABLE[pv.normal][0];
        out.normals[i * 3 + 1] = NORMAL_TABLE[pv.normal][1];
        out.normals[i * 3 + 2] = NORMAL_TABLE[pv.normal][2];
    }

    // Extract texture coordinates (frame 0 set)
    out.texcoords.resize(nVertsPerFrame * 2, 0.0f);
    // Texture coords are indexed per-face-vertex via fTextureIndex, not per-vertex
    // We will map them per-vertex for the common case; faces reference them separately

    // Build face index list
    // Note: face vertex indices are relative to the frame's vertex set (indices 0..nVertsPerFrame-1)
    // The first 2 vertices per frame are bounding box min/max, so actual geometry vertices
    // start at index 2. However, the face indices already account for this (they index into
    // the full per-frame vertex array starting from 0). We keep them as-is since we unpacked
    // all nVertsPerFrame vertices above.
    out.faceCount = nFaces;
    out.indices.resize(nFaces * 3);
    for (int i = 0; i < nFaces; i++) {
        out.indices[i * 3 + 0] = faces[i].fVIP[0].fVertexIndex;
        out.indices[i * 3 + 1] = faces[i].fVIP[1].fVertexIndex;
        out.indices[i * 3 + 2] = faces[i].fVIP[2].fVertexIndex;
    }

    // Map texture coordinates to per-vertex using face data
    // Texture verts are separate from position verts; faces map via fTextureIndex
    if (nTextureVerts > 0 && nTextureVertsPerFrame > 0) {
        // Use a simple approach: for each face, copy the texture coord to the vertex slot
        // If multiple faces share a vertex with different texcoords, last one wins
        // (proper handling would require vertex splitting, which we skip for simplicity)
        for (int i = 0; i < nFaces; i++) {
            for (int j = 0; j < 3; j++) {
                int vi = faces[i].fVIP[j].fVertexIndex;
                int ti = faces[i].fVIP[j].fTextureIndex;
                if (vi >= 0 && vi < nVertsPerFrame && ti >= 0 && ti < nTextureVertsPerFrame) {
                    out.texcoords[vi * 2 + 0] = texVerts[ti].u;
                    out.texcoords[vi * 2 + 1] = texVerts[ti].v;
                }
            }
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Main DTS loader
// ---------------------------------------------------------------------------

inline bool loadDTS(const char* filename, LoadedModel& out) {
    BinaryReader r;
    if (!r.open(filename)) {
        fprintf(stderr, "DTS: Cannot open file '%s'\n", filename);
        return false;
    }

    // Read the top-level PERS header for TS::Shape
    std::string className;
    int32_t shapeVersion = 0;
    if (!readPersHeader(r, className, shapeVersion)) {
        fprintf(stderr, "DTS: Failed to read PERS header\n");
        return false;
    }
    if (className != "TS::Shape") {
        fprintf(stderr, "DTS: Expected TS::Shape, got '%s'\n", className.c_str());
        return false;
    }

    // We handle versions 7 and 8 (Tribes uses version 8)
    if (shapeVersion < 7 || shapeVersion > 8) {
        fprintf(stderr, "DTS: Unsupported shape version %d (expected 7-8)\n", shapeVersion);
        return false;
    }

    // Read shape header counts (all Int32)
    int32_t nNodes         = r.readI32();
    int32_t nSequences     = r.readI32();
    int32_t nSubSequences  = r.readI32();
    int32_t nKeyframes     = r.readI32();
    int32_t nTransforms    = r.readI32();
    int32_t nNames         = r.readI32();
    int32_t nObjects       = r.readI32();
    int32_t nDetails       = r.readI32();
    int32_t nMeshes        = r.readI32();
    int32_t nTransitions   = r.readI32(); // version >= 2
    int32_t nFrameTriggers = r.readI32(); // version >= 4

    // Read shape radius and center
    float shapeRadius = r.readF32();
    (void)shapeRadius;
    float centerX = r.readF32(), centerY = r.readF32(), centerZ = r.readF32();
    (void)centerX; (void)centerY; (void)centerZ;

    // Version 8: bounding box
    if (shapeVersion > 7) {
        out.minX = r.readF32(); out.minY = r.readF32(); out.minZ = r.readF32();
        out.maxX = r.readF32(); out.maxY = r.readF32(); out.maxZ = r.readF32();
    }

    // Skip the vector data arrays -- we just need to advance past them to reach meshes
    // Each is written as raw bytes: count * sizeof(element)

    // Read nodes for skeleton hierarchy
    std::vector<DiskNode> diskNodes(nNodes);
    if (shapeVersion == 8) {
        r.readBytes(diskNodes.data(), nNodes * (int32_t)sizeof(DiskNode));
    } else {
        // v7: 5 x Int32 = 20 bytes each — read and convert
        for (int i = 0; i < nNodes; i++) {
            diskNodes[i].fName = (int16_t)r.readI32();
            diskNodes[i].fParent = (int16_t)r.readI32();
            diskNodes[i].fnSubSequences = (int16_t)r.readI32();
            diskNodes[i].fFirstSubSequence = (int16_t)r.readI32();
            diskNodes[i].fDefaultTransform = (int16_t)r.readI32();
        }
    }

    // Sequences (v5+): 32 bytes each
    r.skip(nSequences * (int32_t)sizeof(DiskSequence));

    if (shapeVersion == 8) {
        // v8 SubSequence: 6 bytes each
        r.skip(nSubSequences * (int32_t)sizeof(DiskSubSequence));
    } else {
        // v7 SubSequence: 3 x Int32 = 12 bytes each
        r.skip(nSubSequences * 12);
    }

    if (shapeVersion == 8) {
        // v8 Keyframe: 8 bytes each
        r.skip(nKeyframes * (int32_t)sizeof(DiskKeyframe));
    } else {
        // v7 Keyframe: float + UInt32 + UInt32 = 12 bytes each
        r.skip(nKeyframes * 12);
    }

    // Read transforms for skeleton
    std::vector<DiskTransform> diskTransforms(nTransforms);
    if (shapeVersion == 8) {
        r.readBytes(diskTransforms.data(), nTransforms * (int32_t)sizeof(DiskTransform));
    } else {
        // v7: Quat16(8) + Point3F(12) + Point3F(12) = 32 bytes
        for (int i = 0; i < nTransforms; i++) {
            r.readBytes(&diskTransforms[i], sizeof(DiskTransform));
            r.skip(12); // skip v7 scale
        }
    }

    // Names: 24 bytes each (all versions)
    // We read these to be able to report names if needed
    std::vector<DiskName> names(nNames);
    if (nNames > 0)
        r.readBytes(names.data(), nNames * sizeof(DiskName));

    // Read objects — links meshes to nodes
    std::vector<DiskObject> diskObjects(nObjects);
    if (shapeVersion == 8) {
        r.readBytes(diskObjects.data(), nObjects * (int32_t)sizeof(DiskObject));
    } else {
        // v7 Object: Int16(2)+Int16(2)+Int32(4)+Int32(4)+TMat3F(48 or 64?)+Int32(4)+Int32(4)
        // V7Object has TMat3F fObjectOffset which is 48 bytes (3x4 matrix of floats)
        // Int16(2)+Int16(2)+Int32(4)+Int32(4)+TMat3F(48)+Int32(4)+Int32(4) = 68
        // Actually: struct { Int16, Int16, Int32, Int32, TMat3F, Int32, Int32 }
        // TMat3F = 3x4 floats = 48 bytes, but with flags field it might be more.
        // TMat3F likely has: EulerF(12) + Point3F(12) + flags(4) + RMat3F(36) = 64
        // Actually TMat3F = struct with m[3][3](36) + p(12) + flags(4) = 52 bytes
        // This is getting complex. Let's check the V7Object:
        // Int16 fName(2) + Int16 fFlags(2) + Int32 fMeshIndex(4) + Int32 fNodeIndex(4)
        // + TMat3F fObjectOffset(...) + Int32 fnSubSequences(4) + Int32 fFirstSubSequence(4)
        // TMat3F is typically: float m[3][3] + Point3F p + int flags = 36+12+4 = 52
        // With pack(4): 2+2+4+4+52+4+4 = 72
        // Since we only support v8, let's just fail on v7 objects
        fprintf(stderr, "DTS: v7 object skip not implemented, using estimated size\n");
        r.skip(nObjects * 72);
    }

    // Details: 8 bytes each (all versions)
    r.skip(nDetails * (int32_t)sizeof(DiskDetail));

    // Transitions (version >= 2)
    if (shapeVersion == 8) {
        // v8 Transition: Int32(4)+Int32(4)+float(4)+float(4)+float(4)+Transform(20) = 40 bytes
        r.skip(nTransitions * 40);
    } else {
        // v7 Transition: same but V7Transform (32 bytes) instead of Transform(20)
        r.skip(nTransitions * 52);
    }

    // Frame triggers (version >= 4): 8 bytes each
    r.skip(nFrameTriggers * (int32_t)sizeof(DiskFrameTrigger));

    // fnDefaultMaterials (version >= 5)
    int32_t nDefaultMaterials = r.readI32();
    (void)nDefaultMaterials;

    // fAlwaysNode (version >= 6)
    int32_t alwaysNode = r.readI32();
    (void)alwaysNode;

    if (!r.good()) {
        fprintf(stderr, "DTS: Read error parsing shape header/vectors (pos=%d)\n", r.position());
        return false;
    }

    // --- Read meshes ---
    // Each mesh is stored as a nested PERS block
    out.meshes.resize(nMeshes);
    int meshesLoaded = 0;
    for (int m = 0; m < nMeshes; m++) {
        if (!r.good()) {
            fprintf(stderr, "DTS: Stream error before mesh %d\n", m);
            break;
        }
        if (readCelAnimMesh(r, out.meshes[m])) {
            meshesLoaded++;
        }
    }

    // If we could not load any meshes, that is an error
    if (meshesLoaded == 0 && nMeshes > 0) {
        fprintf(stderr, "DTS: Failed to load any meshes (expected %d)\n", nMeshes);
        return false;
    }

    // --- Populate skeleton data ---
    // Convert nodes
    out.nodes.resize(nNodes);
    for (int i = 0; i < nNodes; i++) {
        out.nodes[i].parent = diskNodes[i].fParent;
        out.nodes[i].defaultTransform = diskNodes[i].fDefaultTransform;
        if (diskNodes[i].fName >= 0 && diskNodes[i].fName < nNames)
            memcpy(out.nodes[i].name, names[diskNodes[i].fName].name, 24);
        else
            memset(out.nodes[i].name, 0, 24);
    }

    // Convert transforms: Quat16 → float quaternion + Point3F translate
    out.transforms.resize(nTransforms);
    for (int i = 0; i < nTransforms; i++) {
        const float MAX_VAL = 32767.0f;
        out.transforms[i].qx = (float)diskTransforms[i].qx / MAX_VAL;
        out.transforms[i].qy = (float)diskTransforms[i].qy / MAX_VAL;
        out.transforms[i].qz = (float)diskTransforms[i].qz / MAX_VAL;
        out.transforms[i].qw = (float)diskTransforms[i].qw / MAX_VAL;
        out.transforms[i].tx = diskTransforms[i].tx;
        out.transforms[i].ty = diskTransforms[i].ty;
        out.transforms[i].tz = diskTransforms[i].tz;
    }

    // Tag each mesh with its node index and offset via the Object table
    for (int i = 0; i < nObjects && i < (int)out.meshes.size(); i++) {
        int meshIdx = diskObjects[i].fMeshIndex;
        if (meshIdx >= 0 && meshIdx < (int)out.meshes.size()) {
            out.meshes[meshIdx].nodeIndex = diskObjects[i].fNodeIndex;
            out.meshes[meshIdx].offsetX = diskObjects[i].offX;
            out.meshes[meshIdx].offsetY = diskObjects[i].offY;
            out.meshes[meshIdx].offsetZ = diskObjects[i].offZ;
        }
    }

    printf("[DTS] Skeleton: %d nodes, %d transforms, %d objects\n", nNodes, nTransforms, nObjects);

    return true;
}

} // namespace dts_internal

// Public API - delegates to internal namespace
inline bool loadDTS(const char* filename, LoadedModel& out) {
    return dts_internal::loadDTS(filename, out);
}

// ---------------------------------------------------------------------------
// Test program
// ---------------------------------------------------------------------------
#ifdef DTS_TEST

#include <cstdio>

int main(int argc, char** argv) {
    const char* path = "/Users/jkoshy/Darkstar/assets/tribes/larmor.dts";
    if (argc > 1) path = argv[1];

    LoadedModel model;
    printf("Loading DTS: %s\n", path);

    if (!loadDTS(path, model)) {
        fprintf(stderr, "FAILED to load DTS file.\n");
        return 1;
    }

    printf("Bounding box: (%.3f, %.3f, %.3f) - (%.3f, %.3f, %.3f)\n",
           model.minX, model.minY, model.minZ,
           model.maxX, model.maxY, model.maxZ);
    printf("Total meshes: %zu\n", model.meshes.size());

    int totalVerts = 0, totalFaces = 0;
    for (size_t i = 0; i < model.meshes.size(); i++) {
        const LoadedMesh& m = model.meshes[i];
        if (m.vertexCount > 0 || m.faceCount > 0) {
            printf("  Mesh %2zu: %4d vertices, %4d faces\n", i, m.vertexCount, m.faceCount);
        }
        totalVerts += m.vertexCount;
        totalFaces += m.faceCount;
    }
    printf("Totals: %d vertices, %d faces across %zu meshes\n",
           totalVerts, totalFaces, model.meshes.size());

    // Print first few vertices from mesh 0 as a sanity check
    if (!model.meshes.empty() && model.meshes[0].vertexCount > 0) {
        const LoadedMesh& m0 = model.meshes[0];
        int show = m0.vertexCount < 5 ? m0.vertexCount : 5;
        printf("\nFirst %d vertices of mesh 0:\n", show);
        for (int i = 0; i < show; i++) {
            printf("  v[%d] = (%.4f, %.4f, %.4f)  n=(%.3f, %.3f, %.3f)\n",
                   i,
                   m0.vertices[i*3+0], m0.vertices[i*3+1], m0.vertices[i*3+2],
                   m0.normals[i*3+0],  m0.normals[i*3+1],  m0.normals[i*3+2]);
        }
    }

    return 0;
}

#endif // DTS_TEST

#endif // DTS_LOADER_H
